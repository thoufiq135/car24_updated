const bookingQueue=require("./queues/bookingQueue");

(async () => {
  await bookingQueue.add("ride-reminder", { bookingId: 1 });
})();