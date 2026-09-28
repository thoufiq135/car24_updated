const { Pool } = require("pg");
const Redis = require("ioredis");

const admin = require("firebase-admin");

const serviceAccount = require("./car24-4e274-firebase-adminsdk-fbsvc-90761d0011.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://car24-4e274-default-rtdb.firebaseio.com"
});
const fire_db = admin.database(); 


const pool = new Pool({
  host: "100.126.182.3",
  port: 5432,       
  user: "admin",
  password: "admin",
  database: "car24"
});
const redis = new Redis("redis://redis:6379", {
  retryStrategy: (times) => {
    console.log("Retrying Redis...", times);
    return Math.min(times * 100, 2000);
  }
});
// const redis = new Redis({
//   host: "127.0.0.1",
//   port: 6379
// });

function connecttodb() {
  try {
    console.log("Connected to PostgreSQL and Redis and firebase");
  } catch (e) {
    console.log("Error connecting to db", e);
  }
}

module.exports = {connecttodb, pool, redis,fire_db };
