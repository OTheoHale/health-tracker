/* Which surface is this, and which build? One published artifact serves the website, the phone
   PWA and the Mac wrapper, so the page must be able to say plainly which one it is running on.
   ship.sh stamps BUILD here and in sw.js together: if they drift, an updated page keeps being
   served the previous shell out of the old cache. */
window.HealthDelivery = (() => {
  const BUILD = '2026-10-02-V3.5';
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
    /* V3.5 K3: where each of his suggestions stands, by note id (from the export) → the release. `planned`: a release
       brief schedules it; `shipped`: a release built it and it waits for his look. Nothing here resolves a note: only he
       does, in Lessons (shipped is not seen). The release thread fills both at the release and keeps earlier entries.
       `resolved` is the V3.3 map; it now counts as shipped. */
    planned: {},
    shipped: {
      'n-feedback-mufzft4n-0xp3a':'V3.4',
      'n-feedback-muji79ti-rv324':'V3.5',
      'n-feedback-muji8q67-3v5if':'V3.4',
      'n-feedback-muji9t81-lxmg3':'V3.4',
      'n-feedback-mujidx8e-iykjn':'V3.4',
      'n-feedback-mukqfzpn-m995z':'V3.4',
      'n-feedback-mukqvp1v-o0zc4':'V3.4',
      'n-feedback-mukqw3si-izomf':'V3.4',
      'n-feedback-mulm2x21-4bxkj':'V3.4',
      'n-feedback-munu3ggb-q05ph':'V3.4',
      'n-feedback-munu4tg3-tevwo':'V3.4',
      'n-feedback-munu6vlo-jbdhv':'V3.4',
      'n-feedback-muq6rtvo-o7gdu':'V3.5',
      'n-feedback-muq70g1i-ux6hk':'V3.5',
      'n-feedback-muq771lp-6lwtm':'V3.5',
      'n-feedback-muq78rcq-dta6h':'V3.5',
      'n-feedback-muq7bgqv-nxn14':'V3.5',
      'n-feedback-muq7e5q2-8psdz':'V3.5',
      'n-feedback-muq7idbs-utcdc':'V3.5',
      'n-feedback-muq7qibh-a7uji':'V3.5',
      'n-feedback-muq7set2-fj3y1':'V3.5',
      'n-feedback-muq7yxpk-usas5':'V3.5',
      'n-feedback-muq80s74-8k3wh':'V3.5',
      'n-feedback-muq825me-9i45h':'V3.5',
      'n-feedback-muq83wbb-k50ag':'V3.5',
      'n-feedback-muq8ism6-skizm':'V3.5',
      'n-feedback-muq8ljrl-jq7sa':'V3.5',
      'n-feedback-muq8w9pz-2itze':'V3.5',
      'n-feedback-muq8y5pk-31d6g':'V3.5',
      'n-feedback-muqc42uz-72kq4':'V3.5',
      'n-feedback-muqc5v8k-mseos':'V3.5',
      'n-mufzjey8-4dal3':'V3.4',
      'n-muq6yob9-qw1rh':'V3.5',
      'n-muq6z863-nekak':'V3.5',
      'n-muq6zqr4-d5n0m':'V3.5',
      'n-muq7xl8q-a8nd0':'V3.5',
      'n-muq88k1z-1pmn9':'V3.5',
      'n-muq8a88s-frd87':'V3.5',
      'n-muq8cr1n-bp5fg':'V3.5',
      'n-muq8dvd2-dhfwq':'V3.5',
      'n-muq92tdq-41bh1':'V3.5'
    },   // V3.5 release (Oct 2): 41 of his 46 suggestions; O-07, O-09, O-10, O-12 and C-05 stay Open for his look on the Mac
    resolved: {}
  };
})();
