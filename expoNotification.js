const { Expo } = require("expo-server-sdk");

const expo = new Expo();

async function sendNotification(expoPushToken, title, body, data = {}) {
  if (!Expo.isExpoPushToken(expoPushToken)) {
    console.error("Invalid Expo push token");
    return;
  }

  const message = {
    to: expoPushToken,
    sound: "default",
    title: title,
    body: body,
    data: data
  };

  try {
    const ticket = await expo.sendPushNotificationsAsync([message]);
    console.log("Notification sent:", ticket);
    return true
  } catch (error) {
    console.error("Error sending notification:", error);
  }
}

module.exports = sendNotification;