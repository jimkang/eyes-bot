/* global process, __dirname */

var config = require('./config');
var request = require('request');
var postIt = require('@jimkang/post-it');
var waterfall = require('async-waterfall');
var randomId = require('idmaker').randomId;
var probable = require('probable');
var callNextTick = require('call-next-tick');
var pluck = require('lodash.pluck');
var fs = require('fs');
var Jimp = require('jimp');
var ep = require('errorback-promise');
var to = require('await-to-js').to;
var queue = require('d3-queue').queue;

var iscool = require('iscool')();
var sb = require('standard-bail')();

var dryRun = process.argv.length > 2 ? process.argv[2] === '--dry' : false;

var eyeImageFiles = [
  'eyes-293957_640.png' // https://pixabay.com/vectors/eyes-looking-view-look-watch-293957/
];

var eyeImages = [];

var labelsToAvoid = [
  'font',
  'black and white',
  'ancient history',
  'history',
  'historic site',
  'monochrome',
  'monochrome photography',
  'still life photography',
  'photography',
  'aerial photography',
  'close up',
  'painting',
  'architecture',
  'mixed use',
  'residential area',
  'text'
];

const imgLinkRegex = /Size of this preview: <a href="([^"]+)"(\s)/;
const visionAPIURL =
  'https://vision.googleapis.com/v1/images:annotate?key=' +
  config.googleVisionAPIKey;

const maxTries = 5;
var tryCount = 0;

waterfall([loadEyes, attemptAPost], reportError);

function attemptAPost() {
  waterfall([obtainImage, addEyes, postToTargets], wrapUp);
}

function obtainImage(done) {
  var reqOpts = {
    method: 'GET',
    url: 'http://commons.wikimedia.org/wiki/Special:Random/File'
  };
  request(reqOpts, sb(getImageFromPage, done));

  function getImageFromPage(res, body) {
    var result = imgLinkRegex.exec(body);
    if (!result || result.length < 1) {
      done(new Error(`Could not find image link for ${res.url}.`));
    } else {
      var imgLink = result[1];
      var imgReqOpts = {
        method: 'GET',
        url: imgLink,
        encoding: null
      };
      //console.log('imgLink', imgLink);
      request(imgReqOpts, sb(passBuffer, done));
    }
  }

  function passBuffer(res, buffer) {
    done(null, buffer);
  }
}

function addEyes(buffer, done) {
  var requestOpts = {
    url: visionAPIURL,
    method: 'POST',
    json: true,
    body: createPostBody(buffer.toString('base64'))
  };
  request(requestOpts, sb(placeEyes, done));

  async function placeEyes(res, body) {
    console.log('body:', JSON.stringify(body, null, 2));
    var response = body.responses[0];
    var labels = pluck(response.localizedObjectAnnotations, 'name')
      .filter(labelIsAllowed)
      .filter(iscool);
    if (!labels || labels.length < 1) {
      done(new Error('No valid names in localizedObjectAnnotations.'));
      return;
    }
    var label = probable.pickFromArray(labels).replace(/\n/g, '');
    var comment;
    if (label) {
      comment = `The ${label} has eyes!`;
    }

    var eyeBoxes = pluck(
      pluck(response.localizedObjectAnnotations, 'boundingPoly'),
      'normalizedVertices'
    ).map(verticesToBounds);
    console.log('eyeBoxes', eyeBoxes);

    var { error, values } = await ep(addEyesInBoxes, { buffer, eyeBoxes });
    if (error) {
      done(error);
      return;
    }

    done(null, { comment, label, buffer: values[0] });
  }
}

function createPostBody(base64encodedImage) {
  return {
    requests: [
      {
        image: {
          content: base64encodedImage
        },
        features: [
          {
            type: 'OBJECT_LOCALIZATION',
            maxResults: 100
          }
        ]
      }
    ]
  };
}

function postToTargets({ comment, label, buffer }, done) {
  if (dryRun) {
    console.log('Would have posted:', comment);
    var filename = __dirname + '/scratch/' + label + '.jpg';
    fs.writeFileSync(filename, buffer);
    console.log('Wrote', filename);
    callNextTick(done);
  } else {
    const id = 'labelurself-' + randomId(8);
    postIt(
      {
        id,
        text: comment,
        altText: 'Picture in which one may label oneself',
        mediaFilename: id + '.jpg',
        buffer,
        targets: [
          {
            type: 'noteTaker',
            config: config.noteTaker
          }
        ]
      },
      done
    );
  }
}

function wrapUp(error, data) {
  tryCount += 1;

  if (error) {
    console.log(error, error.stack);

    if (data) {
      console.log('data:', data);
    }

    if (tryCount < maxTries) {
      console.log(`Have tried ${tryCount} times. Retrying!`);
      callNextTick(attemptAPost);
    }
  } else {
    console.log('Completed successfully.');
  }
}

// Assumes vertices describe a polygon.
function verticesToBounds(vertices) {
  return vertices.reduce(updateBoundsWithVertex, {
    top: undefined,
    bottom: undefined,
    left: undefined,
    right: undefined
  });
}

function updateBoundsWithVertex(bounds, vertex) {
  if (vertex.x === undefined) {
    bounds.left = 0;
    bounds.right = 1.0;
  } else {
    if (bounds.left === undefined || vertex.x < bounds.left) {
      bounds.left = vertex.x;
    }

    if (bounds.right === undefined || vertex.x > bounds.right) {
      bounds.right = vertex.x;
    }
  }
  if (vertex.y === undefined) {
    bounds.top = 0;
    bounds.bottom = 1.0;
  } else {
    if (bounds.top === undefined || vertex.y < bounds.top) {
      bounds.top = vertex.y;
    }

    if (bounds.bottom === undefined || vertex.y > bounds.bottom) {
      bounds.bottom = vertex.y;
    }
  }
  return bounds;
}

async function addEyesInBoxes({ buffer, eyeBoxes }, done) {
  var [error, image] = await to(Jimp.read(buffer));
  if (error) {
    done(error);
    return;
  }

  eyeBoxes.forEach(addEyesInBox);
  image.getBuffer(Jimp.MIME_JPEG, done);

  function addEyesInBox(eyeBox) {
    // eyeBox values are normalized to 0.0 to 1.0.
    const eyeY =
      eyeBox.top +
      ((eyeBox.bottom - eyeBox.top) * 0.66 * probable.roll(100)) / 100;
    var eyeXDistFromCenter =
      (eyeBox.right - eyeBox.left) / (2 + probable.roll(4));
    if (eyeXDistFromCenter < 0.01) {
      eyeXDistFromCenter = 0.01;
    }
    var eyeImage = probable.pick(eyeImages).clone();

    const eyeWidth = eyeXDistFromCenter * 0.9;
    const centerX =
      eyeBox.left + (eyeBox.right - eyeBox.left) / 2 - eyeWidth / 2;
    /*
    // For now, eye images are all pairs of eyes.
    const leftEyeX = centerX - eyeXDistFromCenter;
    const rightEyeX = centerX + eyeXDistFromCenter;
    // TODO: Take into account size of eye image.
    const leftEyeDestX = image.bitmap.width * leftEyeX;
    const rightEyeDestX = image.bitmap.width * rightEyeX;
    */
    const eyeDestX = image.bitmap.width * centerX;
    const eyeDestY = image.bitmap.height * eyeY;

    eyeImage.resize(eyeWidth * image.bitmap.width, Jimp.AUTO);
    console.log(
      'eye position',
      'left',
      eyeDestX,
      'right',
      eyeDestX,
      'y',
      eyeDestY
    );
    image.composite(eyeImage, eyeDestX, eyeDestY);
    //image.composite(eyeImage, rightEyeDestX, eyeDestY);
  }
}

function labelIsAllowed(label) {
  return label.length > 1 && labelsToAvoid.indexOf(label) === -1;
}

function reportError(error) {
  if (error) {
    console.log(error);
  }
}

function loadEyes(done) {
  var q = queue();
  eyeImageFiles.forEach(queueLoad);
  q.awaitAll(saveImages);

  function queueLoad(imageFile) {
    q.defer(Jimp.read.bind(Jimp), `${__dirname}/eyes/${imageFile}`);
  }

  function saveImages(error, images) {
    if (error) {
      done(error);
    } else {
      eyeImages = images;
      done();
    }
  }
}
