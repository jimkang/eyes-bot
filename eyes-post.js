/* global process, __dirname */

var config = require('./config');
var request = require('request');
var postIt = require('@jimkang/post-it');
var waterfall = require('async-waterfall');
var randomId = require('idmaker').randomId;
var probable = require('probable');
var callNextTick = require('call-next-tick');
var fs = require('fs');
var Jimp = require('jimp');
var ep = require('errorback-promise');
var to = require('await-to-js').to;
var queue = require('d3-queue').queue;
var getAtPath = require('get-at-path');

var iscool = require('iscool')();
var sb = require('standard-bail')();

var dryRun = process.argv.length > 2 ? process.argv[2] === '--dry' : false;

var eyeImageFiles = [
  'eyes-293957_640.png' // https://pixabay.com/vectors/eyes-looking-view-look-watch-293957/
];

var eyeImages = [];

var labelsToAvoid = ['font', 'text', 'Font', 'Text', 'Person'];

const imgLinkRegex = /Size of this preview: <a href="([^"]+)"(\s)/;
const visionAPIURL =
  'https://vision.googleapis.com/v1/images:annotate?key=' +
  config.googleVisionAPIKey;

const eyeProportionOfMaxSizeMin = 0.3;
const eyeProportionOfMaxSizeMax = 0.7;

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
    //console.log('body:', JSON.stringify(body, null, 2));
    var annotations = getAtPath(body, [
      'responses',
      '0',
      'localizedObjectAnnotations'
    ]);
    if (!annotations) {
      done(new Error('No localizedObjectAnnotations in response.'));
      return;
    }

    annotations = annotations.filter(labelIsAllowed);
    if (annotations.length < 1) {
      done(new Error('No valid names in localizedObjectAnnotations.'));
      return;
    }
    var annotation = probable.pick(annotations);
    const label = annotation.name.replace(/\n/g, '');

    // If we ever want to go back to multiple sets of eyes:
    //var eyeBoxes = pluck(
    //  pluck(response.localizedObjectAnnotations, 'boundingPoly'),
    //  'normalizedVertices'
    //).map(verticesToBounds);
    var eyeBoxes = [
      verticesToBounds(annotation.boundingPoly.normalizedVertices)
    ];
    console.log('eyeBoxes', eyeBoxes);

    var { error, values } = await ep(addEyesInBoxes, { buffer, eyeBoxes });
    if (error) {
      done(error);
      return;
    }

    done(null, { comment: '👀', label, buffer: values[0] });
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
    const id = 'eyes-' + randomId(8);
    postIt(
      {
        id,
        text: comment,
        altText: label,
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
    const eyeBoxWidth = eyeBox.right - eyeBox.left;
    const eyeBoxHeight = eyeBox.bottom - eyeBox.top;
    const eyesMaxWidth = eyeBoxWidth * image.bitmap.width;
    const eyesMaxHeight = (eyeBox.bottom - eyeBox.top) * image.bitmap.height;

    var eyeImage = probable.pick(eyeImages).clone();
    eyeImage.contain(eyesMaxWidth, eyesMaxHeight);
    //console.log('eyeImage size', eyeImage.bitmap.width, eyeImage.bitmap.height);
    const eyeProportionOfMax =
      eyeProportionOfMaxSizeMin +
      ((eyeProportionOfMaxSizeMax - eyeProportionOfMaxSizeMin) *
        probable.roll(100)) /
        100;
    console.log('eyeProportionOfMax', eyeProportionOfMax);
    eyeImage.resize(
      eyeImage.bitmap.width * eyeProportionOfMax,
      eyeImage.bitmap.height * eyeProportionOfMax,
      Jimp.AUTO
    );
    //console.log('eyeImage size', eyeImage.bitmap.width, eyeImage.bitmap.height);

    const centerX = (eyeBox.left + eyeBoxWidth / 2) * image.bitmap.width;

    const eyeDestX = centerX - eyeImage.bitmap.width / 2;
    const eyeDestY = (eyeBox.top + eyeBoxHeight / 2) * image.bitmap.height;

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
  }
}

function labelIsAllowed(annotation) {
  var label = annotation.name;
  return (
    label.length > 1 && labelsToAvoid.indexOf(label) === -1 && iscool(label)
  );
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
