// Every exported Cloud Function, grouped by domain file. Deploys as one
// codebase (see firebase.json) - `firebase deploy --only functions` picks
// up every export here automatically.
module.exports = {
  ...require("./activation"),
  ...require("./business_management"),
  ...require("./license_management"),
  ...require("./device_management"),
  ...require("./self_service"),
  ...require("./plans_management"),
  ...require("./payments_management"),
  ...require("./features_management"),
  ...require("./dashboard_stats"),
  ...require("./audit"),
};
