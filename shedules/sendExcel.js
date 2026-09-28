const { Queue } = require("bullmq");
const connection = {
  host: "redis",
  port: 6379,
};
const queue = new Queue("bookingqueue", { connection });

async function startDailySettlementScheduler() {
  await queue.upsertJobScheduler(
    "daily-settlement-scheduler",
    {
      pattern: "0 30 18 * * *",
    },
    {
      name: "daily-settlement",
      data: {},
    }
  );
  await queue.upsertJobScheduler(
    "firebase-settlemen-scheduler",
    {
      pattern: "0 0 19 * * *",
    },
    {
      name: "firebase-settlement",
      data: {},
    }
  );

  console.log("✅ Daily settlement scheduler registered");
}

module.exports = startDailySettlementScheduler;