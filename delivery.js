/* Which surface is this, and which build? One published artifact serves the website, the phone
   PWA and the Mac wrapper, so the page must be able to say plainly which one it is running on.
   ship.sh stamps BUILD here and in sw.js together: if they drift, an updated page keeps being
   served the previous shell out of the old cache. */
window.HealthDelivery = (() => {
  const BUILD = '2026-09-30-V3.3';
  const host = location.hostname;
  const local = /^(127\.0\.0\.1|localhost|\[::1\])$/.test(host);
  const wrapper = !!(window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.native);
  return {
    build: BUILD,
    /* The release number after the date, shown after the app's name: "Health Tracker V1.2". */
    version: (/-(V\d+(?:\.\d+)*)$/.exec(BUILD) || [])[1] || null,
    mode: wrapper ? 'mac' : local ? 'local' : 'hosted',
    hosted: !local && !wrapper,
    /* Body records need a native service, which only the Mac wrapper has. */
    bodyCapable: wrapper || local,
    /* Suggestions a release closed (V3.3, Lessons 3.6): the note id from the improvement brief → the version that
       shipped the change. The app marks each one resolved "as of V…" on its next open; the release thread fills this
       in from the ids the build addressed and keeps earlier entries. */
    resolved: {}
  };
})();
