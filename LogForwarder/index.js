/**
 * Azure function to read from Blob Storage and forward logs to New Relic.
 */

'use strict';

var https = require('https');
var url = require('url');
var zlib = require('zlib');

const VERSION = '0.0.0-development';

// Global constants
const NR_LICENSE_KEY = process.env.NR_LICENSE_KEY;
const NR_INSERT_KEY = process.env.NR_INSERT_KEY;
const NR_ENDPOINT =
  process.env.NR_ENDPOINT || 'https://log-api.newrelic.com/log/v1';
const NR_TAGS = process.env.NR_TAGS; // Semicolon-seperated tags
const NR_LOGS_SOURCE = 'azure';
const NR_MAX_PAYLOAD_SIZE = 1000 * 1024;
const NR_MAX_RETRIES = process.env.NR_MAX_RETRIES || 3;
const NR_RETRY_INTERVAL = process.env.NR_RETRY_INTERVAL || 2000; // default: 2 seconds

module.exports = async function main(context, logMessages) {
  if (!NR_LICENSE_KEY && !NR_INSERT_KEY) {
    context.log.error(
      'You have to configure either your LICENSE key or insights insert key. ' +
        'Please follow the instructions in README'
    );
    return;
  }
  let logs;
  if (typeof logMessages === 'string') {
    logs = logMessages.trim().split('\n');
  } else if (Buffer.isBuffer(logMessages)) {
    logs = logMessages.toString('utf8').trim().split('\n');
  } else if (!Array.isArray(logMessages)) {
    logs = JSON.stringify(logMessages).trim().split('\n');
  } else {
    logs = logMessages;
  }
  let buffer = transformData(logs, context);
  if (buffer.length === 0) {
    context.log.warn('logs format is invalid');
    return;
  }
  let logLines = appendMetaDataToAllLogLines(buffer);
  logLines = appendTimestampToAllLogLines(logLines);
  await compressAndSend(logLines, context);
};

/**
 * Compress and send logs with Promise
 * @param {Object[]} data - array of JSON object containing log message and meta data
 * @param {Object} context - context object passed while invoking this function
 * @returns {Promise} A promise that resolves when logs are successfully sent.
 */

function compressAndSend(data, context) {
  return compressData(JSON.stringify(getPayload(data, context)))
    .then((compressedPayload) => {
      if (compressedPayload.length > NR_MAX_PAYLOAD_SIZE) {
        if (data.length === 1) {
          context.log.error(
            'Cannot send the payload as the size of single line exceeds the limit'
          );
          return;
        }

        let halfwayThrough = Math.floor(data.length / 2);

        let arrayFirstHalf = data.slice(0, halfwayThrough);
        let arraySecondHalf = data.slice(halfwayThrough, data.length);

        return Promise.all([
          compressAndSend(arrayFirstHalf, context),
          compressAndSend(arraySecondHalf, context),
        ]);
      } else {
        return retryMax(httpSend, NR_MAX_RETRIES, NR_RETRY_INTERVAL, [
          compressedPayload,
          context,
        ])
          .then(() =>
            context.log('Logs payload successfully sent to New Relic.')
          )
          .catch((e) => {
            context.log.error(
              'Max retries reached: failed to send logs payload to New Relic'
            );
            context.log.error('Exception: ', JSON.stringify(e));
          });
      }
    })
    .catch((e) => {
      context.log.error('Error during payload compression.');
      context.log.error('Exception: ', JSON.stringify(e));
    });
}

function compressData(data) {
  return new Promise((resolve, reject) => {
    zlib.gzip(data, (e, compressedData) => {
      if (!e) {
        resolve(compressedData);
      } else {
        reject({ error: e, res: null });
      }
    });
  });
}

function appendMetaDataToAllLogLines(logs) {
  return logs.map((log) => addMetadata(log));
}

function appendTimestampToAllLogLines(logs) {
  return logs.map((log) => addTimestamp(log));
}

function getPayload(logs, context) {
  return [
    {
      common: getCommonAttributes(context),
      logs: logs,
    },
  ];
}

function getCommonAttributes(context) {
  return {
    attributes: {
      plugin: {
        type: NR_LOGS_SOURCE,
        version: VERSION,
      },
      azure: {
        forwardername: context.executionContext.functionName,
        invocationid: context.executionContext.invocationId,
      },
      tags: getTags(),
    },
  };
}

function getTags() {
  const tagsObj = {};
  if (NR_TAGS) {
    const tags = NR_TAGS.split(';');
    tags.forEach((tag) => {
      const keyValue = tag.split(':');
      if (keyValue.length > 1) {
        tagsObj[keyValue[0]] = keyValue[1];
      }
    });
  }
  return tagsObj;
}

function addMetadata(logEntry) {
  if (
    logEntry.resourceId !== undefined &&
    typeof logEntry.resourceId === 'string' &&
    logEntry.resourceId.toLowerCase().startsWith('/subscriptions/')
  ) {
    let resourceId = logEntry.resourceId.toLowerCase().split('/');
    if (resourceId.length > 2) {
      logEntry.metadata = {};
      logEntry.azure = {};
      logEntry.metadata.subscriptionId = resourceId[2];
      logEntry.azure.resourceId = logEntry.resourceId.toLowerCase();
    }
    if (resourceId.length > 4) {
      logEntry.metadata.resourceGroup = resourceId[4];
    }
    if (resourceId.length > 6 && resourceId[6]) {
      logEntry.metadata.source = resourceId[6].replace('microsoft.', 'azure.');
    }
    if (resourceId.length > 7) {
      logEntry.azure.resourceType = resourceId[6] + '/' + resourceId[7];
      logEntry.displayName = resourceId[8];
    }
  }
  return logEntry;
}

// Add log generation time as a timestamp
function addTimestamp(logEntry) {
  if (
    logEntry.time !== undefined &&
    typeof logEntry.time === 'string' &&
    !isNaN(Date.parse(logEntry.time))
  ) {
    logEntry.timestamp = Date.parse(logEntry.time);
  }else if (
    logEntry.timeStamp !== undefined &&
    typeof logEntry.timeStamp === 'string' &&
    !isNaN(Date.parse(logEntry.timeStamp))
  ) {
    logEntry.timestamp = Date.parse(logEntry.timeStamp);
  }

  return logEntry;
}

function transformData(logs, context) {
  // buffer is an array of JSON objects
  let buffer = [];

  let parsedLogs = parseData(logs, context);

  // type JSON object
  if (
    !Array.isArray(parsedLogs) &&
    typeof parsedLogs === 'object' &&
    parsedLogs !== null
  ) {
    if (parsedLogs.records !== undefined) {
      context.log('Type of logs: records Object');
      parsedLogs.records.forEach((log) => buffer.push(log));
      return buffer;
    }
    context.log('Type of logs: JSON Object');
    buffer.push(parsedLogs);
    return buffer;
  }

  // Bad Format
  if (!Array.isArray(parsedLogs)) {
    return buffer;
  }

  if (typeof parsedLogs[0] === 'object' && parsedLogs[0] !== null) {
    // type JSON records
    if (parsedLogs[0].records !== undefined) {
      context.log('Type of logs: records Array');
      parsedLogs.forEach((message) => {
        message.records.forEach((log) => buffer.push(log));
      });
      return buffer;
    } // type JSON array
    context.log('Type of logs: JSON Array');
    // normally should be "buffer.push(log)" but that will fail if the array mixes JSON and strings
    parsedLogs.forEach((log) => buffer.push({ message: log }));
    // Our API can parse the data in "log" to a JSON and ignore "message", so we are good!
    return buffer;
  }
  if (typeof parsedLogs[0] === 'string') {
    // type string array
    context.log('Type of logs: string Array');
    parsedLogs.forEach((logString) => buffer.push({ message: logString }));
    return buffer;
  }
  return buffer;
}

function parseData(logs, context) {
  if (!Array.isArray(logs)) {
    try {
      return JSON.parse(logs); // for strings let's see if we can parse it into Object
    } catch {
      context.log.warn('cannot parse logs to JSON');
      return logs;
    }
  }
  try {
    // if there is any exception during JSON.parse,
    // it would be either due to logs in object format itself or log strings in non-json format.
    return logs.map((log) => JSON.parse(log));
  } catch (e) {
    // for both of the above exception cases, return logs would be fine.
    return logs;
  }
}

function httpSend(data, context) {
  return new Promise((resolve, reject) => {
    const urlObj = url.parse(NR_ENDPOINT);
    const options = {
      hostname: urlObj.hostname,
      port: 443,
      path: urlObj.pathname,
      protocol: urlObj.protocol,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Encoding': 'gzip',
      },
    };

    if (NR_LICENSE_KEY) {
      options.headers['X-License-Key'] = NR_LICENSE_KEY;
    } else {
      options.headers['X-Insert-Key'] = NR_INSERT_KEY;
    }

    var req = https.request(options, (res) => {
      var body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk; // don't really do anything with body
      });
      res.on('end', () => {
        context.log('Got response:' + res.statusCode);
        if (res.statusCode === 202) {
          resolve(body);
        } else {
          reject({ error: null, res: res });
        }
      });
    });

    req.on('error', (e) => {
      reject({ error: e, res: null });
    });
    req.write(data);
    req.end();
  });
}

/**
 * Retry with Promise
 * fn: the function to try
 * retry: the number of retries
 * interval: the interval in millisecs between retries
 * fnParams: list of params to pass to the function
 * @returns A promise that resolves to the final result
 */

function retryMax(fn, retry, interval, fnParams) {
  return fn.apply(this, fnParams).catch((err) => {
    return retry > 1
      ? wait(interval).then(() => retryMax(fn, retry - 1, interval, fnParams))
      : Promise.reject(err);
  });
}

function wait(delay) {
  return new Promise((fulfill) => {
    setTimeout(fulfill, delay || 0);
  });
}
