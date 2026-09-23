/* Which surface is this, and which build? One published artifact serves the website, the phone
   PWA and the Mac wrapper, so the page must be able to say plainly which one it is running on.
   ship.sh stamps BUILD here and in sw.js together: if they drift, an updated page keeps being
   served the previous shell out of the old cache. */
window.HealthDelivery = (() => {
  const BUILD = '2026-09-23-0122';
  const host = location.hostname;
  const local = /^(127\.0\.0\.1|localhost|\[::1\])$/.test(host);
  const wrapper = !!(window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.native);
  return {
    build: BUILD,
    mode: wrapper ? 'mac' : local ? 'local' : 'hosted',
    hosted: !local && !wrapper,
    /* Body records need a native service, which only the Mac wrapper has. */
    bodyCapable: wrapper || local
  };
})();
