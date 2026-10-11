// Typed command modules for the Premiere UXP panel (core owns getState, runScript, runScriptFile, __e2e_*).
"use strict";

module.exports = [
  require("./createProject.js"),
  require("./openProject.js"),
  require("./saveProject.js"),
  require("./getProjectItems.js"),
  require("./importFiles.js"),
  require("./importAEComps.js"),
  require("./replaceMedia.js"),
  require("./createSequence.js"),
  require("./getSequence.js"),
  require("./buildSequence.js"),
  require("./editItems.js"),
  require("./placeAudio.js"),
  require("./setAudio.js"),
  require("./addTransition.js"),
  require("./setSpeed.js"),
  require("./addMarkers.js"),
  require("./exportSequence.js"),
];
