window.WIND_DASHBOARD_CONFIG = {

  siteName: "SPL Wind Turbine Test Site",

  stationName: "SPL Wind Monitoring Station",

  stationLocation: "Victoria, Australia",

  stationId: "WIND-001",

  elevationMeters: null,

  deviceName: "Seeed XIAO ESP32-C3",

  latitude: -38.33920835101432,

  longitude: 144.7383156116512,

  mapZoom: 8,

  firebaseDatabaseUrl:
    "https://spl-wind-live-default-rtdb.asia-southeast1.firebasedatabase.app",

  // Firebase console -> Project settings -> General -> Web API key.
  //
  // This is safe to publish. A Web API key identifies the project; it grants
  // nothing on its own. It only lets the page ASK Firebase to verify an email
  // and password, and what the resulting account may do is decided entirely by
  // firebase/database.rules.json. Leave it empty to disable the operator
  // controls altogether - the dashboard then stays read-only.
  firebaseWebApiKey: "",

  // Optional convenience: pre-fills the operator email in the unlock dialog so
  // only the password has to be typed. The password is never stored anywhere in
  // this repository or in the page.
  operatorEmail: "",

  refreshSeconds: 2,

  offlineAfterSeconds: 12

};
