const { Worker } = require("bullmq");
const { rideReminderJob, ridePenaltyJob, rideAutoExtendJob, rideStartReminderJob,autoCancle } = require("../jobs/rideJobs");
const { dailySettlementJob,firebaseSettlementJob } = require("../jobs/finacial");

console.log("🚀 Worker started...");

const worker = new Worker(
  "bookingqueue",
  async (job) => {
    console.log("Running job:", job.name);

    switch (job.name) {
      case "ride-reminder": {
        const { bookingId, expoToken } = job.data;
        return rideReminderJob({ bookingId, expoToken });
      }

      case "ride-penalty": {
        const { bookingId, seater } = job.data;
        return ridePenaltyJob({ bookingId, seater });
      }

      case "ride-auto-extend": {
        const { bookingId } = job.data;
        return rideAutoExtendJob({ bookingId });
      }

      case "daily-settlement":
        return dailySettlementJob();
case "firebase-settlement":
        return firebaseSettlementJob();

      case "ride-start-reminder": {
        const { bookingId, expoToken } = job.data;
        return rideStartReminderJob({ bookingId, expoToken });
      }
      case "auto-cancle":{
        const {bookingId,expoToken}=job.data;
        return autoCancle({bookingId,expoToken})
      }

      default:
        console.log("Unknown job");
        return null;
    }
  },
  {
    connection: {
      host: "redis",
      port: 6379,
    },
  }
);

worker.on("completed", (job) => {
  console.log(`✅ Job completed: ${job.name}`);
});

worker.on("failed", (job, err) => {
  console.log(`❌ Job failed: ${job?.name}`, err.message);
});

worker.on("error", (err) => {
  console.log("🚨 Worker error:", err.message);
});
