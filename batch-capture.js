const _ = require('lodash');
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const shell = require('shelljs');
const program = require('commander');
const puppeteer = require('puppeteer');
const fileUrl = require('file-url');
const imagemin = require('imagemin');
const imagemin_pngquant = require('imagemin-pngquant');
const imagemin_mozjpeg = require('imagemin-mozjpeg');
const version = require('./package.json').version;

const MAX_VIEWPORT = {width: 1920, height: 1080};
const MIN_FILESIZE = 5 * 1024;
const MAX_TRIES = 40;

// Modernize setTimeout
function sleep(timeout) {
    return new Promise((resolve) => {
        setTimeout(resolve, timeout);
    })
}

async function renderPage(page, directory) {
    await page.setViewport({...MAX_VIEWPORT, deviceScaleFactor: program.scale});

    const uri = fileUrl(path.join(directory, program.index));
    console.log(`Loading ${uri}`);
    await page.goto(uri);

    await sleep(program.wait * 1000);

    const templateVars = Object.assign({folder: path.basename(directory)}, _.pick(program, ['quality', 'index', 'el', 'wait']));
    const outputFilename = path.normalize(path.join(directory, outputTemplate(templateVars)));
    const outputPath = path.dirname(outputFilename);
    const type = (path.extname(outputFilename).toLowerCase() === '.png') ? 'png' : 'jpeg';
    shell.mkdir('-p', outputPath);

    const clip = await page.evaluate(selector => document.querySelector(selector).getBoundingClientRect().toJSON(), program.el);

    const screenshotParams = {path: outputFilename, clip, type};
    if (type === 'jpeg') {
        screenshotParams.quality = 100;
    }
    await page.screenshot(screenshotParams);

    return outputFilename;
}


async function optimizeImages(uncompressedFiles) {
    // provided in kb, convert to bytes
    const targetSize = program.targetsize * 1024;
    assert(targetSize > MIN_FILESIZE, `Provided target size of ${targetSize} bytes is impossibly small`);

    let targetQuality = program.quality;
    assert(targetQuality >= 0 && targetQuality <= 100, `Initial quality should be between 0 and 100, recommend 100`);

    const destination = path.join(path.dirname(uncompressedFiles[0]), 'optimized');
    let needRecompression = _.clone(uncompressedFiles);

    for (let i = 0; needRecompression.length > 0 && i < MAX_TRIES; i++) {
        console.log(`Compressing ${needRecompression.length} image[s] at quality ${targetQuality.toFixed(0)}...`);
        const out = await imagemin(needRecompression, {
            destination,
            glob: false,
            plugins: [
                imagemin_mozjpeg({quality: targetQuality}),
                imagemin_pngquant({strip: true, quality: [0, targetQuality / 100.0]}),
            ]
        });
        needRecompression = out
            .map(obj => obj.destinationPath)
            .filter(filename => fs.statSync(filename).size > targetSize);
        targetQuality *= 0.95;
    }
    if (needRecompression.length > 0) {
        console.error(`${needRecompression.length} files could not hit target filesize ${(targetSize / 1024).toFixed(0)}kb in ${MAX_TRIES} iterations. Try a larger target filesize.`)
    }
}

async function go(rootDir) {
    console.log("Booting up puppeteer...");
    const instance = await puppeteer.launch();
    const uncompressedFiles = [];
    try {
        const page = await instance.newPage();
        console.log("Capturing pages...");
        for (const fn of shell.find(rootDir).filter(fn => path.basename(fn) === program.index)) {
            const outputFilename = await renderPage(page, path.dirname(fn));
            console.log(outputFilename);
            uncompressedFiles.push(outputFilename);
        }
    } finally {
        await instance.close();
    }

    if (uncompressedFiles.length > 0) {
        console.log("Opimizing images...");
        await optimizeImages(uncompressedFiles);
    }

    console.log("DONE.");
}


program
    .version(version)
    .usage('[options] <directory>')
    .description('Capture a specific HTML element from each file. Start looking in <directory>, usually "."')
    .option('-i, --index <filename.html>', 'Name of HTML file to look for in each directory', 'index.html')
    .option('-e, --el <selector>', 'CSS selector for HTML element to grab', '#container')
    .option('-o, --output <filename>', 'Output filename pattern, relative to the containing folder. You can use ' +
        'variables in this string such as {folder} for the folder name, {index} {el} and {wait} from above options. ' +
        'Supported file types are .png and .jpg.', '../backup_{folder}.jpg')
    .option('-w, --wait <sec>', 'Time to wait in seconds', parseFloat, 0.1)
    .option('-s, --scale <float>', 'Physical pixel scale, use 2 for @2x retina', parseFloat, 1)
    .option('-t, --targetsize <kb>', 'Output to an image with file size equal to the target size in kb', 40)
    .option('-q, --quality <0-100>', 'Compressed image quality for the first pass of compression', parseFloat, 100)
    .parse(process.argv);

// Make a template function out of the passed template string, using single curly braces for variables
const outputTemplate = _.template(program.output, {interpolate: /{([\s\S]+?)}/g});

if (!program.args.length) {
    program.help();
} else {
    go(program.args[0]);
}
