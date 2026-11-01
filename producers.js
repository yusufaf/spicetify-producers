// NAME: Producers
// AUTHOR: yusufaf
// DESCRIPTION: Show each track's producers, from Spotify's own credits, as a column on album and playlist pages.
//
// Producers moved to https://github.com/yusufaf/spicetify-extensions/tree/main/extensions/producers
// This file only loads it from there, so installs from this repository keep updating.
// Install it from the new location to stop depending on this redirect.

(function () {
  const script = document.createElement('script');
  script.src = 'https://cdn.jsdelivr.net/gh/yusufaf/spicetify-extensions@main/extensions/producers/producers.js';
  script.onerror = () => console.error('[Producers] Could not load the extension from https://cdn.jsdelivr.net/gh/yusufaf/spicetify-extensions@main/extensions/producers/producers.js');
  document.head.appendChild(script);
})();
