import elasticlunr from 'elasticlunr';

import Keys from './Keys';
import macros from './macros';
import CourseProData from './classModels/DataLib';

// The plan is to use this in both the frontend and the backend.
// Right now it is only in use in the backend.


const classSearchConfig = {
  fields: {
    classId: {
      boost: 4,
    },
    acronym: {
      boost: 4,
    },
    subject: {
      boost: 2,
    },
    desc: {
      boost: 1,
    },
    name: {
      boost: 1,
    },
    profs: {
      boost: 1,
    },

    // Enable this again if this is added to the index.

    // locations: {
    //   boost: 1,
    // },
    crns: {
      boost: 1,
    },
  },
  expand: true,
};

const employeeSearchConfig = {
  fields: {
    name: {
      boost: 2,
    },
    primaryRole: {
      boost: 1,
    },
    primaryDepartment: {
      boost: 1,
    },
    emails: {
      boost: 1,
    },
    phone: {
      boost: 1,
    },
    // officeRoom: {
    //   boost: 1,
    // },
  },
  expand: true,
};


class Search {

  constructor(termDump, classSearchIndex, employeeMap, employeeSearchIndex) {
    this.termDump = CourseProData.loadData(termDump);
    this.classSearchIndex = elasticlunr.Index.load(classSearchIndex);
    this.employeeMap = employeeMap;
    this.employeeSearchIndex = elasticlunr.Index.load(employeeSearchIndex);

    // Save the refs for each query. This is a map from the query to a object like this: {refs: [...], time: Date.now()}
    // These are purged every so often.
    this.refCache = {};


    this.onInterval = this.onInterval.bind(this);

    // 24 HR in ms
    setInterval(this.onInterval, 86400000);
  }

  // Use this to create a search intance
  // All of these arguments should already be JSON.parsed(). (Eg, they should be objects, not strings).
  static create(termDump, classSearchIndex, employeeMap, employeeSearchIndex) {
    // Some sanitiy checking
    if (!termDump || !classSearchIndex || !employeeMap || !employeeSearchIndex) {
      console.error('Error, missing arguments.', termDump, classSearchIndex, employeeMap, employeeSearchIndex);
      return null;
    }


    return new this(termDump, classSearchIndex, employeeMap, employeeSearchIndex);
  }

  onInterval() {
    const dayAgo = Date.now() - 86400000;

    const keys = Object.keys(this.refCache);

    // Clear out any cache that has not been used in over a day.
    for (const key of keys) {
      if (this.refCache[key].time < dayAgo) {
        this.refCache[key] = undefined;
      }
    }
  }

  checkForSubjectMatch(searchTerm) {

    // This is O(n), but because there are so few subjects it usually takes < 1ms
    // If the search term starts with a subject (eg cs2500), put a space after the subject
    const lowerCaseSearchTerm = searchTerm.toLowerCase().trim();
    const subjects = this.termDump.getSubjects();

    for (let i = 0; i < subjects.length; i++) {
      const subject = subjects[i];
      const lowerCaseSubject = subject.subject.toLowerCase();
      const lowerCaseText = subject.text.toLowerCase();

      // Perfect match for a subject, list all the classes in the subject
      if (lowerCaseSubject === lowerCaseSearchTerm || lowerCaseSearchTerm === lowerCaseText) {
        macros.log('Perfect match for subject!', subject.subject);

        const results = this.termDump.getClassesInSubject(subject.subject);

        const output = [];
        results.forEach((result) => {
          output.push({
            score: 0,
            ref: result,
            type: 'class',
          });
        });

        return output;
      }
    }
    return null;
  }

  // Internal use only.
  // Given a refs, minIndex and a maxIndex it will return the new minIndex and maxIndex that includes all results that have score that match scores that 
  // are included in refs. The given refs array must be sorted.
  static expandRefsSliceForMatchingScores(refs, minIndex, maxIndex) {
    while (minIndex > 0 && refs[minIndex].score === refs[minIndex - 1].score) {
      minIndex --;
    }

    // If the max index is greater than the number of refs, just sort all the refs.
    if (refs.length <= maxIndex) {
      maxIndex = refs.length - 1
    }

    // Same thing for the end. 
    while (refs[maxIndex + 1] && refs[maxIndex + 1].score === refs[maxIndex].score) {
      maxIndex ++;
    }

    return {
      minIndex: minIndex,
      maxIndex: maxIndex
    }
  }


  static getBusinessScore(object) {
    if (object.type === 'class') {
      if (object.sections.length === 0) {
        return 0
      }

      // Find the number of taken seats. 
      let takenSeats = 0;
      for (const section of object.sections) {
        takenSeats += section.seatsCapacity - section.seatsRemaining

        // Also include the number of seats on the waitlist, if there is a waitlist. 
        if (section.waitCapacity !== undefined && section.waitRemaining !== undefined) {
          takenSeats += section.waitCapacity - section.waitRemaining
        }

      }

      // If there are many taken seats, there is clearly an interest in the class. 
      // Rank these the highest. 
      if (takenSeats > 0) {
        return takenSeats + 1000000;
      }

      // Rank these higher than classes with no sections, but less than everything else.
      if (!macros.isNumeric(object.class.classId)) {
        return 1;
      }


      let classNum = parseInt(object.class.classId, 10)

      // I haven't seen any that are over 10k, but just in case log a waning and clamp it. 
      if (classNum > 10000) {
        macros.log("Warning: class num", classNum, ' is over 10k', object.class.classId)
        return 2;
      }

      return 10000 - classNum;
    }
    else if (object.type === 'employee') {
      return Object.keys(object.employee);
    }
    else {
      console.error("Yooooooo omg y", object)
      return 0
    }
  }

  // Takes in a list of search result objects
  // and sorts the ones with matching scores in place by the business metric. 
  // In other works, if the scores match for a bunch of objects, it will sort then based on the business metric.
  // If the scores do not match, it will leave them sorted by score. 
  static sortObjectsAfterScore(objects) {
    let index = 0;
    while (index < objects.length) {

      let currentScore = objects[index].score;
      let currentChunk = [objects[index]];
      let startIndex = index;
      while (index + 1 < objects.length && objects[index].score === objects[index + 1].score) {
        currentChunk.push(objects[index + 1])
        index ++;
      }

      currentChunk.sort((a,b) => {
        let aScore = this.getBusinessScore(a)
        let bScore = this.getBusinessScore(b)
        if (aScore >= bScore) {
          return -1;
        }
        else if (aScore === bScore) {
          return 0
        }
        else {
          return 1;
        }
      })

      for (var i = 0; i < currentChunk.length; i++) {
        objects[startIndex + i] = currentChunk[i]
      }

      index ++;
      
    }

    return objects
  }


  // Main search function. The min and max index are used for pagenation.
  // Eg, if you want results 10 through 20, call search('hi there', 10, 20)
  search(searchTerm, minIndex = 0, maxIndex = 1000) {
    if (maxIndex <= minIndex) {
      console.error('Error. Max index < Min index.', minIndex, maxIndex, maxIndex <= minIndex, typeof maxIndex, typeof minIndex)
      return [];
    }
    // Searches are case insensitive.
    searchTerm = searchTerm.trim().toLowerCase();

    let wasSubjectMatch = false;
    

    // Cache the refs.
    let refs;
    if (this.refCache[searchTerm]) {
      refs = this.refCache[searchTerm].refs;
      wasSubjectMatch = this.refCache[searchTerm].wasSubjectMatch;

      // Update the timestamp of this cache item.
      this.refCache[searchTerm].time = Date.now();
    } else {
      let possibleSubjectMatch = this.checkForSubjectMatch(searchTerm);
      if (possibleSubjectMatch) {
        refs = possibleSubjectMatch
        wasSubjectMatch = true;
      }
      else {
        refs = this.getRefs(searchTerm);
      }

      this.refCache[searchTerm] = {
        refs: refs,
        wasSubjectMatch: wasSubjectMatch,
        time: Date.now(),
      };
    }

    // If there were no results or asking for a range beyond the results length, stop here.
    if (refs.length === 0 || minIndex >= refs.length) {
      return [];
    }

    // We might need to load more data than we are going to return
    // Keep track of how many more we added in the beginning so we can skip those when returning the results.
    // Also keep track of how many items we are going to return.
    // One possible tweak to this code is to not sort past index 50. 
    // The order of results past this don't really matter that much so we really don't need to sort them. 

    // Step 1: Figure out what items we need to load. 
    const returnItemCount = maxIndex - minIndex;

    let originalMinIndex = minIndex;

    // Don't re-order based on business score if there was a subject match. 
    if (!wasSubjectMatch) {
      let newMaxAndMinIndex = this.constructor.expandRefsSliceForMatchingScores(refs, minIndex, maxIndex);
      minIndex = newMaxAndMinIndex.minIndex;
      maxIndex = newMaxAndMinIndex.maxIndex;
    }

    // Discard this many items from the beginning of the array before they are returned to the user. 
    // They are only included here because these specific items have the same score and may be sorted into the section that the user is requesting. 
    let startOffset = originalMinIndex - minIndex;

    // Step 2: Load those items. 
    let objects = [];
    refs = refs.slice(minIndex, maxIndex + 1);
    for (const ref of refs) {
      if (ref.type === 'class') {
        const aClass = this.termDump.getClassServerDataFromHash(ref.ref);

        if (!aClass) {
          console.error('yoooooo omg', ref);
        }

        const sections = [];

        if (aClass.crns) {
          for (const crn of aClass.crns) {
            const sectionKey = Keys.create({
              host: aClass.host,
              termId: aClass.termId,
              subject: aClass.subject,
              classUid: aClass.classUid,
              crn: crn,
            }).getHash();

            if (!sectionKey) {
              console.error('Error no hash', crn, aClass);
            }

            sections.push(this.termDump.getSectionServerDataFromHash(sectionKey));
          }
        }

        objects.push({
          score: ref.score,
          type: ref.type,
          class: aClass,
          sections: sections,
        });
      } else if (ref.type === 'employee') {
        objects.push({
          score: ref.score,
          employee: this.employeeMap[ref.ref],
          type: ref.type,
        });
      } else {
        console.error('unknown type!');
      }
    }


    if (!wasSubjectMatch) {

      const startTime = Date.now()

      // Sort the objects by chunks that have the same score. 
      objects = this.constructor.sortObjectsAfterScore(objects);

      macros.log("Sorting took ", Date.now() - startTime, 'ms', objects.length, startOffset, returnItemCount)
    }


    return objects.slice(startOffset, startOffset + returnItemCount);
  }


  // This returns an object like {ref: 'neu.edu/201810/CS/...' , type: 'class'}
  getRefs(searchTerm) {

    // This is O(n), but because there are so few subjects it usually takes < 1ms
    // If the search term starts with a subject (eg cs2500), put a space after the subject
    const lowerCaseSearchTerm = searchTerm.toLowerCase().trim();
    const subjects = this.termDump.getSubjects();

    for (let i = 0; i < subjects.length; i++) {
      const subject = subjects[i];
      const lowerCaseSubject = subject.subject.toLowerCase();

      if (lowerCaseSearchTerm.startsWith(lowerCaseSubject)) {
        const remainingSearch = searchTerm.slice(lowerCaseSubject.length);

        // Only rewrite the search if the rest of the query has a high probability of being a classId.
        if (remainingSearch.length > 5) {
          break;
        }
        const match = remainingSearch.match(/\d/g);

        if (!match || match.length < 3) {
          break;
        } else {
          searchTerm = `${searchTerm.slice(0, lowerCaseSubject.length)} ${searchTerm.slice(lowerCaseSubject.length)}`;
        }
        break;
      }
    }

    // Check to see if the search is for an email, and if so remove the @northeastern.edu and @neu.edu
    searchTerm = searchTerm.replace(/@northeastern\.edu/gi, '').replace(/@neu\.edu/gi, '');


    // Measure how long it takes to search. Usually this is very small (< 20ms)
    // const startTime = Date.now();

    // Returns an array of objects that has a .ref and a .score
    // The array is sorted by score (with the highest matching closest to the beginning)
    // eg {ref:"neu.edu/201710/ARTF/1123_1835962771", score: 3.1094880801464573}
    // macros.log(searchTerm)
    const classResults = this.classSearchIndex.search(searchTerm, classSearchConfig);

    const employeeResults = this.employeeSearchIndex.search(searchTerm, employeeSearchConfig);

    // macros.log('send', 'timing', `search ${searchTerm.length}`, 'search', Date.now() - startTime);

    const output = [];

    // This takes no time at all, never more than 2ms and usually <1ms
    while (true) {
      if (classResults.length === 0 && employeeResults.length === 0) {
        break;
      }

      if (classResults.length === 0) {
        output.push({
          type: 'employee',
          ref: employeeResults[0].ref,
          score: employeeResults[0].score
        });
        employeeResults.splice(0, 1);
        continue;
      }

      if (employeeResults.length === 0) {
        output.push({
          type: 'class',
          ref: classResults[0].ref,
          score: classResults[0].score
        });

        classResults.splice(0, 1);
        continue;
      }

      if (classResults[0].score > employeeResults[0].score) {
        output.push({
          type: 'class',
          ref: classResults[0].ref,
          score: classResults[0].score
        });
        classResults.splice(0, 1);
        continue;
      }

      if (classResults[0].score <= employeeResults[0].score) {
        output.push({
          type: 'employee',
          ref: employeeResults[0].ref,
          score: employeeResults[0].score
        });
        employeeResults.splice(0, 1);
      }
    }

    return output;
  }

}

export default Search;
