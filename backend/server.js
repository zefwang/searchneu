/*
 * This file is part of Search NEU and licensed under AGPL3.
 * See the license file in the root folder for details.
 */

import path from 'path';
import express from 'express';
import webpack from 'webpack';
import webpackMiddleware from 'webpack-dev-middleware';
import webpackHotMiddleware from 'webpack-hot-middleware';
import wrap from 'express-async-wrap';
import compress from 'compression';
import rollbar from 'rollbar';
import bodyParser from 'body-parser';
import moment from 'moment';
import xhub from 'express-x-hub';
import atob from 'atob';
import _ from 'lodash';
import elastic from './elastic';

import Request from './scrapers/request';
import webpackConfig from './webpack.config.babel';
import macros from './macros';
import notifyer from './notifyer';
import Updater from './updater';
import database from './database';

// This file manages every endpoint in the backend
// and calls out to respective files depending on what was called

const request = new Request('server');

const app = express();

// This xhub code is responsible for verifying that requests that hit the /webhook endpoint are from facebook in production
// This does some crypto stuff to make this verification
// This way, only facebook can make calls to the /webhook endpoint
// This is not used in development
const fbAppSecret = macros.getEnvVariable('fbAppSecret');

// Start updater interval
// TODO: FIX!!!!!!
Updater.create();

// Verify that the webhooks are coming from facebook
// This needs to be above bodyParser for some reason
app.use(xhub({ algorithm: 'sha1', secret: fbAppSecret }));

// gzip the output
app.use(compress());

// Process application/x-www-form-urlencoded
app.use(bodyParser.urlencoded({ extended: false }));

// Process application/json
app.use(bodyParser.json());

// Prevent being in an iFrame.
app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (macros.PROD) {
    // Assets are cached for a day.
    // This time interval was chosen because the scrapers are ran daily, so there is no point for the browser to update the cache more often that this.
    // These Cache-control headers are far from perfect though haha
    res.setHeader('Cache-Control', 'public, max-age=86400');
  } else {
    // Don't cache in DEV
    // Could also use no-store which would prevent the browser from storing it all.
    // This no-cache header requires the browser to revalidate the cache with the server before serving it.
    res.setHeader('Cache-Control', 'no-cache');
  }
  next();
});

// Prefer the headers if they are present so we get the real ip instead of localhost (nginx) or a cloudflare IP
function getIpPath(req) {
  const output = [];

  const realIpHeader = req.headers['x-real-ip'];
  if (realIpHeader) {
    output.push('Real:');
    output.push(realIpHeader);
    output.push(' ');
  }

  const forwardedForHeader = req.headers['x-forwarded-for'];
  if (forwardedForHeader) {
    output.push('ForwardedFor:');
    output.push(forwardedForHeader);
    output.push(' ');
  }

  if (req.connection.remoteAddress !== '127.0.0.1') {
    output.push('remoteIp: ');
    output.push(req.connection.remoteAddress);
  }

  return output.join('');
}


// This is more complicated than just req.connection.remoteAddress (which will always be 127.0.0.1)
// because this Node.js server is running behind both nginx and Cloudflare.
// This will return the IP of the user connecting to the site
// Because there are two step between us and the user,
// we need to check the second the last item in the x-forwarded-for header.
// We shouldn't check the first item in the header, because someone could send a forged x-forwarded-for header
// that would be added to the beginning of the x-forwarded-for that is received here.
function getRemoteIp(req) {
  const forwardedForHeader = req.headers['x-forwarded-for'];

  if (!forwardedForHeader) {
    if (macros.PROD) {
      macros.error('No forwardedForHeader?', req.headers, req.connection.remoteAddress);
    }

    return req.connection.remoteAddress;
  }

  const splitHeader = forwardedForHeader.split(',');

  // Cloudflare sometimes sends health check requests
  // which will only have 1 item in this header
  if (splitHeader.length === 1) {
    macros.error('Only have one item in the header?', forwardedForHeader);
    return splitHeader[0].trim();
  }


  if (splitHeader.length > 2) {
    macros.log('Is someone sending a forged header?', forwardedForHeader);
  }

  return splitHeader[splitHeader.length - 2].trim();
}

// Gets the current time, just used for loggin
function getTime() {
  return moment().format('hh:mm:ss a');
}


// Http to https redirect.
app.use((req, res, next) => {
  const remoteIp = getIpPath(req);

  // If this is https request, done.
  if (req.protocol === 'https') {
    next();

    // If we are behind a cloudflare proxy and cloudflare served a https response, done.
  } else if (req.headers['x-forwarded-proto'] && req.headers['x-forwarded-proto'] === 'https') {
    next();

    // This is development mode
  } else if (macros.DEV) {
    next();

    // This is prod and still on http, redirect to https.
  } else {
    // Cache the http to https redirect for 2 months.
    res.setHeader('Cache-Control', 'public, max-age=5256000');
    macros.log(getTime(), remoteIp, 'redirecting to https');
    res.redirect(`https://${req.get('host')}${req.originalUrl}`);
  }
});

app.get('/search', wrap(async (req, res) => {
  if (macros.DEV && !await elastic.isConnected()) {
    const fromProd = await request.get(`https://searchneu.com${req.originalUrl}`);
    res.send(fromProd.body);
    macros.log('In dev mode and Elasticsearch not available. Hitting production search API endpoint');
    return;
  }

  if (!req.query.query || typeof req.query.query !== 'string' || req.query.query.length > 500) {
    macros.log(getTime(), 'Need query.', req.query);
    res.send(JSON.stringify({
      error: 'Need query param.',
    }));
    return;
  }

  if (!macros.isNumeric(req.query.minIndex) || !macros.isNumeric(req.query.maxIndex)) {
    macros.log('Need numbers as max and min index.');
    res.send(JSON.stringify({
      error: 'Max and Min index must be numbers.',
    }));
    return;
  }

  let minIndex = 0;
  if (req.query.minIndex) {
    minIndex = parseInt(req.query.minIndex, 10);
  }

  let maxIndex = 10;
  if (req.query.maxIndex) {
    maxIndex = parseInt(req.query.maxIndex, 10);
  }

  if (!req.query.termId || req.query.termId.length !== 6) {
    macros.log('Invalid termId.');
    res.send(JSON.stringify({
      error: 'Invalid termid.',
    }));
    return;
  }

  const { searchContent, took, resultCount } = await elastic.search(req.query.query, req.query.termId, req.query.minIndex, req.query.maxIndex);
  const midTime = Date.now();

  let string;
  if (req.query.apiVersion === '2') {
    string = JSON.stringify({ results: searchContent });
  } else {
    string = JSON.stringify(searchContent);
  }

  // Not sure I am logging all the necessary analytics
  const analytics = {
    searchTime: took,
    stringifyTime: Date.now() - midTime,
    resultCount: resultCount,
  };

  macros.logAmplitudeEvent('Backend Search', analytics);

  macros.log(getTime(), getIpPath(req), 'Search for', req.query.query, 'from', minIndex, 'to', maxIndex, 'took', took, 'ms and stringify took', Date.now() - midTime, 'with', analytics.resultCount, 'results');

  // Set the header for application/json and send the data.
  res.setHeader('Content-Type', 'application/json; charset=UTF-8');
  res.send(string);
}));


// for Facebook verification of the endpoint.
app.get('/webhook/', (req, res) => {
  const verifyToken = macros.getEnvVariable('fbVerifyToken');

  if (req.query['hub.verify_token'] === verifyToken) {
    macros.log('yup!');
    res.send(req.query['hub.challenge']);
  } else {
    res.send('Error, wrong token');
  }
});

async function onSendToMessengerButtonClick(sender, userPageId, b64ref) {
  macros.log('Got opt in button click!', b64ref);
  if (macros.DEV && !await elastic.isConnected()) {
    macros.log('In dev mode and Elasticsearch not available. Class watching does not work');
    return;
  }

  // The frontend send a classHash to follow and a list of sectionHashes to follow.
  let userObject = {};
  try {
    userObject = JSON.parse(atob(b64ref));
  } catch (e) {
    macros.error('Unable to parse user data from frontend?', b64ref);
    return;
  }

  // When the site is running in development mode,
  // and the send to messenger button is clicked,
  // Facebook will still send the webhooks to prod
  // Keep another field on here to keep track of whether the button was clicked in prod or in dev
  // and if it was in dev ignore it
  if (userObject.dev && macros.PROD) {
    return;
  }

  if (!userObject.classHash || !userObject.sectionHashes || !userObject.loginKey) {
    macros.error('Invalid user object from webhook ', userObject);
    return;
  }

  if (typeof userObject.loginKey !== 'string' || userObject.loginKey.length !== 100) {
    macros.error('Invalid login key', userObject.loginKey);
    return;
  }

  macros.log('User Object is', userObject);

  const firebaseRef = await database.getRef(`/users/${sender}`);

  let existingData = await firebaseRef.once('value');
  existingData = existingData.val();

  const aClass = (await elastic.get(elastic.CLASS_INDEX, userObject.classHash)).class;

  // User is signing in from a new device
  if (existingData) {
    // Add this array if it dosen't exist. It should exist
    if (!existingData.watchingClasses) {
      existingData.watchingClasses = [];
    }

    if (!existingData.watchingSections) {
      existingData.watchingSections = [];
    }

    const wasWatchingClass = existingData.watchingClasses.includes(userObject.classHash);

    const sectionWasentWatchingBefore = [];

    for (const section of userObject.sectionHashes) {
      if (!existingData.watchingSections.includes(section)) {
        sectionWasentWatchingBefore.push(section);
      }
    }

    const classCode = `${aClass.subject} ${aClass.classId}`;
    // Check to see how many of these classes they were already signed up for.
    if (wasWatchingClass && sectionWasentWatchingBefore.length === 0) {
      notifyer.sendFBNotification(sender, `You are already signed up to get notifications if any of the sections of ${classCode} have seats that open up.`);
    } else if (wasWatchingClass && sectionWasentWatchingBefore.length > 0) {
      notifyer.sendFBNotification(sender, `You are already signed up to get notifications if seats open up in some of the sections in ${classCode} and are now signed up for ${sectionWasentWatchingBefore.length} more sections too!`);
    } else if (sectionWasentWatchingBefore.length === 0) {
      notifyer.sendFBNotification(sender, `Successfully signed up for notifications if sections are added to ${classCode}!`);
    } else {
      notifyer.sendFBNotification(sender, `Successfully signed up for notifications for ${sectionWasentWatchingBefore.length} sections in ${classCode}!`);
    }

    // ok lets add what classes the user saw in the frontend that have no seats availible and that he wants to sign up for
    // so pretty much the same as courspro - the class hash and the section hashes - but just for the sections that the user sees that are empty
    // so if a new section is added then a notification will be send off that it was added but the user will not be signed up for it

    // Only add if it dosen't already exist in the user data.
    if (!existingData.watchingClasses.includes(userObject.classHash)) {
      existingData.watchingClasses.push(userObject.classHash);
    }

    existingData.watchingSections = _.uniq(existingData.watchingSections.concat(userObject.sectionHashes));

    // Remove any null or undefined values from the watchingClasses and watchingSections
    // This can happen if data is manually deleted from the DB, and the data is no longer contineous.
    // (eg index 0 is deleted and Google keeps the others at index 1 and index 2, so index 0 just contains undefined)
    if (existingData.watchingClasses.includes(undefined) || existingData.watchingSections.includes(undefined)) {
      macros.log('existing data class hashes or section hashes includes undefined!', existingData.watchingClasses, existingData.watchingSections);
    }

    if (existingData.watchingClasses.includes(null) || existingData.watchingSections.includes(null)) {
      macros.log('existing data class hashes or section hashes includes null!', existingData.watchingClasses, existingData.watchingSections);
    }

    _.pull(existingData.watchingClasses, null);
    _.pull(existingData.watchingClasses, undefined);

    _.pull(existingData.watchingSections, null);
    _.pull(existingData.watchingSections, undefined);


    // Add the login key to the array of login keys stored on this user
    if (!existingData.loginKeys) {
      existingData.loginKeys = [];
    }

    const loginKeys = new Set(existingData.loginKeys);
    loginKeys.add(userObject.loginKey);
    existingData.loginKeys = Array.from(loginKeys);

    firebaseRef.set(existingData);
  } else {
    let names = await notifyer.getUserProfileInfo(sender);
    if (!names || !names.first_name) {
      macros.warn('Unable to get name', names);
      names = {};
    } else {
      macros.log('Got first name and last name', names.first_name, names.last_name);
    }

    const newUser = {
      watchingSections: userObject.sectionHashes,
      watchingClasses: [userObject.classHash],
      firstName: names.first_name,
      lastName: names.last_name,
      facebookMessengerId: sender,
      facebookPageId: userPageId,
      loginKeys: [userObject.loginKey],
    };

    macros.log('Adding ', newUser, 'to the db');


    // Send the user a notification letting them know everything was successful.
    notifyer.sendFBNotification(sender, `Thanks for signing up for notifications ${names.first_name}! I'll send you another message if a seat opens up in ${aClass.subject} ${aClass.classId}!`);

    database.set(`/users/${sender}`, newUser);
  }
}

async function unsubscribeSender(sender) {
  const firebaseRef = await database.getRef(`/users/${sender}`);

  let existingData = await firebaseRef.once('value');
  existingData = existingData.val();

  if (existingData) {
    existingData.watchingClasses = [];
    existingData.watchingSections = [];
    macros.log('Unsubscribed ', sender, ' from everything.');
    firebaseRef.set(existingData);
  } else {
    macros.log("Didn't unsubscribe ", sender, ' from anything because they were not in the database');
  }

  notifyer.sendFBNotification(sender, "You've been unsubscribed from everything! Free free to re-subscribe to updates on https://searchneu.com");
}

// In production, this is called from Facebook's servers.
// When a user sends a Facebook messsage to the Search NEU bot or when someone hits the send to messenger button.
// If someone sends a message to this bot it will respond with some hard-coded responses
// In development, this is called directly from the frontend so the backend will do the same actions as it would in prod for the same user actions in the frontend.
// Facebook will still call the webhook on the production server when the send to messenger button is clicked in dev. This webhook call is ignored in prod.
app.post('/webhook/', wrap(async (req, res) => {
  // Verify that the webhook is actually coming from Facebook.
  // This is important.
  if ((!req.isXHub || !req.isXHubValid()) && macros.PROD) {
    macros.log(getTime(), getIpPath(req), 'Tried to send a webhook');
    macros.log(req.headers);
    res.send('nope');
    return;
  }

  // Check to see if the body is valid (https://rollbar.com/ryanhugh/searchneu/items/54/)
  if (!req.body || !req.body.entry || req.body.entry.length === 0) {
    macros.log('Invalid body on webhook?', req.body);
    res.send('nope');
    return;
  }

  // Now process the message.
  const messagingEvents = req.body.entry[0].messaging;
  for (let i = 0; i < messagingEvents.length; i++) {
    const event = messagingEvents[i];
    const sender = event.sender.id;
    if (event.message && event.message.text) {
      const text = event.message.text;

      if (text === 'test') {
        notifyer.sendFBNotification(sender, 'CS 1800 now has 1 seat available!! Check it out on https://searchneu.com/cs1800 !');
      } else if (text.toLowerCase() === 'stop') {
        unsubscribeSender(sender);
      } else if (text === 'What is my facebook messenger sender id?') {
        notifyer.sendFBNotification(sender, sender);
      } else {
        // Don't send anything if the user sends a message.
        // notifyer.sendFBNotification(sender, "Yo! 👋😃😆 I'm the Search NEU bot. I will notify you when seats open up in classes that are full. Sign up on https://searchneu.com !");
      }
    } else if (event.optin) {
      onSendToMessengerButtonClick(sender, req.body.entry[0].id, event.optin.ref);

      // We should allways respond with a 200 status code, even if there is an error on our end.
      // If we don't we risk being unsubscribed for webhook events.
      // https://developers.facebook.com/docs/messenger-platform/webhook
      res.send(JSON.stringify({
        status: 'OK',
      }));
      return;
    } else {
      macros.log('Unknown webhook', sender, JSON.stringify(event), JSON.stringify(req.body));
    }
  }
  res.sendStatus(200);
}));

app.post('/subscribeEmail', wrap(async (req, res) => {
  // Don't cache this endpoint.
  res.setHeader('Cache-Control', 'no-cache, no-store');

  if (!req.body || !req.body.email) {
    macros.log('invalid email ingored:', req.body);
    res.send(JSON.stringify({
      error: 'nope.',
    }));
    return;
  }

  if (macros.occurrences(req.body.email, '@', true) !== 1) {
    macros.log('invalid email ingored:', req.body);
    res.send(JSON.stringify({
      error: 'nope.',
    }));
    return;
  }

  macros.logAmplitudeEvent('Backend Email Submit', { email: req.body.email });
  macros.log(req.body.email, 'subscribing');

  // Regardless of what happens from here out, we want to tell the user this was successful.
  // So tell them now to prevent some delay.
  res.send(JSON.stringify({
    status: 'success',
  }));

  const body = {
    email_address: req.body.email,
    status: 'subscribed',
  };

  const mailChimpKey = macros.getEnvVariable('mailChimpKey');

  if (mailChimpKey) {
    if (macros.PROD) {
      macros.log('Submitting email', req.body.email, 'to mail chimp.');

      // The first part of the url comes from the API key.
      let response;

      try {
        response = await request.post({
          url: 'https://us16.api.mailchimp.com/3.0/lists/31a64acc18/members/',
          headers: {
            Authorization: `Basic: ${mailChimpKey}`,
          },
          body: JSON.stringify(body),
        });
      } catch (e) {
        macros.log('Failed to submit email', req.body.email);

        // Don't tell the frontend this email has already been submitted.
        return;
      }

      macros.log(response.body);
    } else {
      macros.log('Not submitting ', req.body.email, 'to mailchimp because not in PROD');
    }
  } else {
    macros.log("Not submitting to mailchip, don't have mailchimp key.");
  }
}));


// Rate-limit submissions on a per-IP basis
let rateLimit = {};
let lastHour = 0;

app.post('/submitFeedback', wrap(async (req, res) => {
  // Don't cache this endpoint.
  res.setHeader('Cache-Control', 'no-cache, no-store');

  if (!req.body.message) {
    macros.log('Empty message?');
    res.send(JSON.stringify({
      error: 'Need message.',
    }));
    return;
  }

  const userIp = getRemoteIp(req);

  const currentHour = String(parseInt(Date.now() / (1000 * 60 * 60), 10));

  // Clear out the rate limit once per hour
  // Do this instead of a timer because the vast majority of the time people are not going to be submitting
  // submissions, and this works just as well.
  if (lastHour !== currentHour) {
    lastHour = currentHour;
    rateLimit = {};
  }


  if (!rateLimit[userIp]) {
    rateLimit[userIp] = 0;
  }

  // Max ten submissions per hour
  if (rateLimit[userIp] >= 10) {
    res.send({
      error: 'Rate limit reached. Please wait an hour before submitting again.',
    });

    return;
  }

  rateLimit[userIp]++;

  let message = `Feedback form submitted: ${req.body.message}`;

  if (req.body.contact) {
    message += ` | ${req.body.contact}`;
  }


  // Ryan's User ID for the Search NEU in facebook.
  // In order to send Ryan a FB message with this ID you would need the secret key for the Search NEU page
  const response = await notifyer.sendFBNotification('1397905100304615', message);

  // Also send a message to Da-Jin
  const response2 = await notifyer.sendFBNotification('2289421987761573', message);

  if (response.error || response2.error) {
    macros.log(response.error, response2.error);
    res.send(JSON.stringify({
      error: 'Error.',
    }));
  } else {
    res.send(JSON.stringify({
      status: 'Success.',
    }));
  }
}));

// This variable is also used far below to serve static files from ram in dev
let middleware;

if (macros.DEV) {
  const compiler = webpack(webpackConfig);
  middleware = webpackMiddleware(compiler, {
    publicPath: webpackConfig.output.publicPath,
    logLevel: 'silent',
    stats: {
      colors: true,
      timings: true,
      hash: false,
      chunksM: false,
      chunkModules: false,
      modules: false,
    },
  });


  app.use(middleware);
  app.use(webpackHotMiddleware(compiler, {
    log: false,
  }));
}


// Respond to requests for the api and log info to amplitude.
app.get('/data/*', wrap(async (req, res, next) => {
  // Gather some info and send it to amplitude
  const info = { ...req.headers };

  info.ip = getRemoteIp(req);
  info.url = req.url;

  macros.logAmplitudeEvent('API Request', info);

  // Use express to send the static file
  express.static('public')(req, res, next);
}));


app.use(express.static('public'));

// Google Search Console Site Verification.
// I could make this a static file... but it is never going to change so though this would be easier.
// If this is removed, the domain will no longer be verified with Google.
app.get('/google840b636639b40c3c.html', (req, res) => {
  res.write('google-site-verification: google840b636639b40c3c.html');
  res.end();
});

// Bing site authentication.
app.get('/BingSiteAuth.xml', (req, res) => {
  res.write('<?xml version="1.0"?>\n<users>\n  <user>8E6E97A65CAB89F73346E3E6DCE84142</user>\n</users>');
  res.end();
});

app.get('*', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=UTF-8');
  if (macros.PROD) {
    res.sendFile(path.join(process.cwd(), 'public', 'index.html'));
  } else {
    res.write(middleware.fileSystem.readFileSync(path.join(webpackConfig.output.path, 'index.html')));
    res.end();
  }
});


// your express error handler
// Express handles functions with four arguments as error handlers and functions with 3 arguments as middleware
// Add the eslint comment to keep all the args.
app.use((err, req, res, next) => { //eslint-disable-line no-unused-vars
  // in case of specific URIError
  if (err instanceof URIError) {
    macros.log('Warning, could not process malformed url: ', req.url);
    return res.send('Invalid url.');
  }
  macros.error(err);
  return res.send(err);
});

// If this port is ever changed we would also need to update the port in Facebook's whitelisted_domains
let port;
if (macros.DEV) {
  port = 5000;
} else {
  port = 5000;
}


const rollbarKey = macros.getEnvVariable('rollbarPostServerItemToken');

if (macros.PROD) {
  if (rollbarKey) {
    rollbar.init(rollbarKey);
    const rollbarFunc = rollbar.errorHandler(rollbarKey);

    // https://rollbar.com/docs/notifier/node_rollbar/
    // Use the rollbar error handler to send exceptions to your rollbar account
    app.use(rollbarFunc);
  } else {
    macros.error("Don't have rollbar key! Skipping rollbar. :O");
  }
} else if (macros.DEV && !rollbarKey) {
  macros.log("Don't have rollbar key! Skipping rollbar. :O");
}


app.listen(port, '0.0.0.0', (err) => {
  if (err) {
    macros.log(err);
  }

  macros.logAmplitudeEvent('Backend Server startup', {});

  macros.log(`Listening on port ${port}.`);
});
