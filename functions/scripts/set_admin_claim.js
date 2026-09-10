// One-time/occasional bootstrap: grants a Firebase Auth user a `role`
// custom claim so they can sign into the admin dashboard and call the
// admin-only licensing endpoints. There is no self-serve admin signup -
// the account must already exist (created via the Firebase console or
// `firebase auth:import`) before this is run.
//
//   node scripts/set_admin_claim.js <uid-or-email> <role>
//
// role is one of: super_admin | license_admin | support_admin | finance_admin | read_only

const admin = require('firebase-admin');
admin.initializeApp();

const VALID_ROLES = ['super_admin', 'license_admin', 'support_admin', 'finance_admin', 'read_only'];

async function main() {
  const [identifier, role] = process.argv.slice(2);
  if (!identifier || !VALID_ROLES.includes(role)) {
    console.error(`Usage: node scripts/set_admin_claim.js <uid-or-email> <${VALID_ROLES.join('|')}>`);
    process.exit(1);
  }
  const user = identifier.includes('@') ?
    await admin.auth().getUserByEmail(identifier) :
    await admin.auth().getUser(identifier);
  await admin.auth().setCustomUserClaims(user.uid, { role });
  console.log(`Granted role "${role}" to ${user.email || user.uid}. They must sign out/in for it to take effect.`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
