const admin = require("firebase-admin");
const { getApps, getApp } = require("firebase-admin/app");
const path = require("path");

const serviceAccount = require(path.join(
  __dirname,
  "notifycar24-firebase-adminsdk-fbsvc-e3780cf844.json"
));
console.log("service account",serviceAccount)
const app = getApps().length
  ? getApp()
  : admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId: "notifycar24",
    });

async function sendfireNotification(tokens, title, body, data = {}) {
  try {
    if (typeof tokens === "string") {
      const response = await admin.messaging().send({
        token: tokens,
        notification: { title, body },
        data,
      });
      return response;
    }

    if (Array.isArray(tokens) && tokens.length > 0) {
      const response = await admin.messaging().sendEachForMulticast({
        tokens,
        notification: { title, body },
        data,
      });
      return response;
    }

    return null;
  } catch (err) {
    console.log(err);
    throw err;
  }
}

module.exports =  sendfireNotification;