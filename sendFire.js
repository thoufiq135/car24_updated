async function saveCancelRequestToFirebase({
  bookingId,
  title,
  message,
  type,
  fromEmail,
  toEmail,
}) {
  const notificationRef = fire_db.ref("notifications").push();

  await notificationRef.set({
    bookingId,
    title,
    message,
    type,
    from: fromEmail,
    to: toEmail,
    read: false,
    createdAt: Date.now(),
  });

  return notificationRef.key;
}
module.exports={saveCancelRequestToFirebase}