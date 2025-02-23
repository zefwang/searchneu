/*
 * This file is part of Search NEU and licensed under AGPL3.
 * See the license file in the root folder for details.
 */

import React from 'react';
import PropTypes from 'prop-types';
import { Button, Modal } from 'semantic-ui-react';

import macros from './macros';
import facebook from './facebook';
import user from './user';

// This file is responsible for the Sign Up for notifications flow.
// First, this will render a button that will say something along the lines of "Get notified when...!"
// Then, if that button is clicked, the Facebook Send To Messenger button will be rendered.
// (This Sent To Messenger button is not rendered initially because it requires that an iframe is added and 10+ http requests are made for each time it is rendered)

// TODO: Lets make it so clicking on the Send To Messenger button changes this to a third state that just says thanks for signing up!

class SignUpForNotifications extends React.Component {
  static propTypes = {
    aClass: PropTypes.object.isRequired,
  };

  constructor(props) {
    super(props);

    this.state = {
      showMessengerButton: false,

      // Keeps track of whether the adblock message is being shown or not
      // Sometimes, adblock will block the FB plugin from loading
      // Firefox strict browsing also blocks this plugin from working
      // If the plugin failed to load for whatever reason, show this message and ask the user to allow FB plugins
      showAdblockMessage: false,
    };

    this.facebookScopeRef = null;
    this.onSubscribeToggleChange = this.onSubscribeToggleChange.bind(this);
    this.closeModal = this.closeModal.bind(this);
  }

  // After the button is added to the DOM, we need to tell FB's SDK that it was added to the code and should be processed.
  // This will tell FB's SDK to scan all the child elements of this.facebookScopeRef to look for fb-send-to-messenger buttons.
  // If the user goes to this page and is not logged into Facebook, a send to messenger button will still appear and they
  // will be asked to sign in after clicking it.
  async componentDidUpdate() {
    if (!this.facebookScopeRef) {
      return;
    }

    const FB = await facebook.getFBPromise();

    // Check for this.facebookScopeRef again because some rollbar errors were coming in that it was changed to null
    // while the await above was running
    // https://rollbar.com/ryanhugh/searchneu/items/373/
    if (!FB || !this.facebookScopeRef) {
      return;
    }

    FB.XFBML.parse(this.facebookScopeRef);

    const iframe = this.facebookScopeRef.querySelector('iframe');

    if (!iframe) {
      macros.logAmplitudeEvent('FB Send to Messenger', {
        message: 'Unable to load iframe for send to messenger plugin.',
        hash: this.props.aClass.getHash(),
      });
      macros.error('No iframe?');
      return;
    }

    iframe.onload = () => {
      // Check to see if the plugin was successfully rendered
      const ele = this.facebookScopeRef.querySelector('.sendToMessengerButton > span');

      const classHash = this.props.aClass.getHash();

      // If has adblock and haven't shown the warning yet, show the warning.
      if (ele.offsetHeight === 0 && ele.offsetWidth === 0 && !facebook.didPluginRender()) {
        if (macros.isMobile) {
          macros.error('Unable to render on mobile?', classHash);

          macros.logAmplitudeEvent('FB Send to Messenger', {
            message: 'Unable to render on mobile?.',
            hash: classHash,
          });
        } else {
          macros.logAmplitudeEvent('FB Send to Messenger', {
            message: "User has adblock or isn't logged in. Showing adblock/login popup.",
            hash: classHash,
          });

          this.setState({
            showAdblockMessage: true,
          });
          facebook.pluginFailedToRender();
        }
      } else {
        macros.logAmplitudeEvent('FB Send to Messenger', {
          message: 'Successfully rendered',
          hash: classHash,
        });
      }
    };
  }

  // Updates the state to show the button.
  async onSubscribeToggleChange() {
    macros.logAmplitudeEvent('FB Send to Messenger', {
      message: 'First button click',
      hash: this.props.aClass.getHash(),
    });

    // Check the status of the FB plugin
    // If it failed to load, show the message that asks user to disable adblock
    const newState = {
      showMessengerButton: true,
    };

    try {
      await facebook.getFBPromise();
    } catch (e) {
      newState.showAdblockMessage = true;
    }

    this.setState(newState);
  }

  // Return the FB button itself.
  getSendToMessengerButton() {
    const loginKey = user.getLoginKey();

    const aClass = this.props.aClass;

    // Get a list of all the sections that don't have seats remaining
    const sectionsHashes = [];
    for (const section of aClass.sections) {
      if (section.seatsRemaining <= 0) {
        sectionsHashes.push(section.getHash());
      }
    }

    // JSON stringify it and then base64 encode the data that we want to pass to the backend.
    // Many characters arn't allowed to be in the ref attribute, including open and closing braces.
    // So base64 enocode it and then decode it on the server. Without the base64 encoding, the button will not render.
    const dataRef = btoa(JSON.stringify({
      classHash: aClass.getHash(),
      sectionHashes: sectionsHashes,
      dev: macros.DEV,
      loginKey: loginKey,
    }));

    return (
      <div ref={ (ele) => { this.facebookScopeRef = ele; } } className='inlineBlock'>
        <div
          className='fb-send-to-messenger sendToMessengerButton'
          messenger_app_id='1979224428978082'
          page_id='807584642748179'
          data-ref={ dataRef }
          color='white'
          size='large'
        />
      </div>
    );
  }

  closeModal() {
    this.setState({
      showAdblockMessage: false,
    });
  }

  render() {
    let content = null;

    if (this.state.showMessengerButton) {
      if (facebook.didPluginFail()) {
        content = <Button basic content='Disable adblock to continue' className='diableAdblockButton' disabled />;
      } else {
        content = (
          <div className='facebookButtonContainer'>
            <div className='sendToMessengerButtonLabel'>
              Click this button to continue
            </div>
            {this.getSendToMessengerButton()}
          </div>
        );
      }
    } else if (this.props.aClass.sections.length === 0) {
      content = <Button basic onClick={ this.onSubscribeToggleChange } content='Get notified when sections are added!' className='notificationButton' />;
    } else if (this.props.aClass.isAtLeastOneSectionFull()) {
      content = <Button basic onClick={ this.onSubscribeToggleChange } content='Get notified when seats open up!' className='notificationButton' />;
    } else {
      // Show a button that says there are currently seats available.
      content = (
        <div className='disabledButton notificationButton'>
          There are seats available in all sections.
        </div>
      );
    }

    const actions = [
      {
        key: 'done',
        content: 'Ok',
        positive: true,
        onClick: this.closeModal,
      },
    ];

    return (
      <div className='sign-up-for-notifications-container'>
        {content}
        <Modal
          header='Please disable adblock and sign into Facebook.'
          open={ this.state.showAdblockMessage }
          content="Please disable any ad blocking extentions for this site because this feature does not work when adblock is enabled. If you are using Firefox in strict blocking mode, you will need to add an exception for this site for this feature to work. You will also have to uninstall Facebook Container for Firefox, if you have that installed. You can also try using a different browser. If you can't get it working send me a message at ryanhughes624@gmail.com."
          actions={ actions }
        />
      </div>
    );
  }
}

export default SignUpForNotifications;
