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
var pluck = require('lodash.pluck');

var iscool = require('iscool')();
var sb = require('standard-bail')();

var dryRun = process.argv.length > 2 ? process.argv[2] === '--dry' : false;

var eyeImageFiles = [
  'eyes-293957_640.png' // https://pixabay.com/vectors/eyes-looking-view-look-watch-293957/
];

var eyeImages = [];

var labelsToAvoid = [
  'font',
  'text',
  'Font',
  'Text',
  'Person',
  'Clothing',
  'Man',
  'Woman',
  'Hat',
  'Outerwear',
  'Dress',
  'Packaged goods',
  'Top',
  'Pillow',
  'Flute',
  'Ski'
];

const defaultEyeY = 0.5;

var eyeYForSpecificTopics = {
  Glasses: 0.0,
  Sunglasses: 0.0,
  Umbrella: 0.0,
  Helmet: 0.05,
  Table: 0.0,
  Animal: 0.3,
  Cat: 0.2,
  Dog: 0.2,
  Bird: 0.2,
  'Bronze Sculpture': 0.1,
  Jeans: 0.05,
  Pants: 0.05,
  Chair: 0.2,
  Axe: 0.1
};

const imgLinkRegex = /Size of this preview: <a href="([^"]+)"(\s)/;
const visionAPIURL =
  'https://vision.googleapis.com/v1/images:annotate?key=' +
  config.googleVisionAPIKey;

const eyeProportionOfMaxSizeMin = 0.3;
const eyeProportionOfMaxSizeMax = 0.5;

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

    // Use all annotations most of the time; sometimes just a few.
    const numberOfAnnotationsToUse =
      probable.roll(5) === 0
        ? annotations.length
        : probable.rollDie(annotations.length);
    annotations = probable.sample(annotations, numberOfAnnotationsToUse);
    const label = pluck(annotations, 'name')
      .map(cleanName)
      .join(', ');

    var eyeBoxes = probable.sample(annotations).map(annotationToEyeBox);
    //console.log('eyeBoxes', eyeBoxes);
    eyeBoxes = eyeBoxes.reduce(doesNotOverlapPrevBoxes, []);
    //console.log('eyeBoxes', eyeBoxes);

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

function annotationToEyeBox(annotation) {
  return {
    name: annotation.name,
    bounds: verticesToBounds(annotation.boundingPoly.normalizedVertices)
  };
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
    var eyeY = eyeYForSpecificTopics[eyeBox.name];
    if (eyeY === undefined) {
      eyeY = defaultEyeY;
    }

    // eyeBox values are normalized to 0.0 to 1.0.
    const eyeBoxWidth = eyeBox.bounds.right - eyeBox.bounds.left;
    const eyeBoxHeight = eyeBox.bounds.bottom - eyeBox.bounds.top;
    const eyesMaxWidth = eyeBoxWidth * image.bitmap.width;
    const eyesMaxHeight =
      (eyeBox.bounds.bottom - eyeBox.bounds.top) * image.bitmap.height;

    var eyeImage = probable.pick(eyeImages).clone();
    eyeImage.contain(eyesMaxWidth, eyesMaxHeight);
    //console.log('eyeImage size', eyeImage.bitmap.width, eyeImage.bitmap.height);
    const eyeProportionOfMax =
      eyeProportionOfMaxSizeMin +
      ((eyeProportionOfMaxSizeMax - eyeProportionOfMaxSizeMin) *
        probable.roll(100)) /
        100;
    //console.log('eyeProportionOfMax', eyeProportionOfMax);
    eyeImage.resize(
      eyeImage.bitmap.width * eyeProportionOfMax,
      eyeImage.bitmap.height * eyeProportionOfMax,
      Jimp.AUTO
    );
    //console.log('eyeImage size', eyeImage.bitmap.width, eyeImage.bitmap.height);

    const centerX = (eyeBox.bounds.left + eyeBoxWidth / 2) * image.bitmap.width;

    const eyeDestX = centerX - eyeImage.bitmap.width / 2;
    const eyeDestY =
      (eyeBox.bounds.top + eyeBoxHeight * eyeY) * image.bitmap.height;

    //console.log(
    //  'eye position',
    //  'left',
    //  eyeDestX,
    //  'right',
    //  eyeDestX,
    //  'y',
    //  eyeDestY
    //);
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

function cleanName(name) {
  return name.replace(/\n/g, '');
}

function overlaps(bounds1, bounds2) {
  var left1IsInsideEl2, right1IsInsideEl2, top1IsInsideEl2, bottom1IsInsideEl2;

  left1IsInsideEl2 = nIsInsideRange(bounds1.left, bounds2.left, bounds2.right);
  if (!left1IsInsideEl2) {
    right1IsInsideEl2 = nIsInsideRange(
      bounds1.right,
      bounds2.left,
      bounds2.right
    );
  }

  top1IsInsideEl2 = nIsInsideRange(bounds1.top, bounds2.top, bounds2.bottom);
  if (!top1IsInsideEl2) {
    bottom1IsInsideEl2 = nIsInsideRange(
      bounds1.bottom,
      bounds2.top,
      bounds2.bottom
    );
  }

  return (
    (left1IsInsideEl2 || right1IsInsideEl2) &&
    (top1IsInsideEl2 || bottom1IsInsideEl2)
  );
}

function nIsInsideRange(n, lower, upper) {
  return n >= lower && n <= upper;
}

function doesNotOverlapPrevBoxes(prevBoxes, box) {
  if (!prevBoxes.some(overlapsBox)) {
    prevBoxes.push(box);
  }
  return prevBoxes;

  function overlapsBox(prevBox) {
    return overlaps(prevBox.bounds, box.bounds);
  }
}
