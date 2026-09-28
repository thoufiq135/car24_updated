const {pool,fire_db}=require("../connectdb")
const {sendFinancialReport}=require("../generateData_test")
const ExcelJS = require("exceljs");
const {  fetchCollectionData,
  createCollectionExcel}=require("../getExcel")
  const sendEmail=require("../email")

const path = require("path");
const dailySettlementJob = async () => {
  console.log("Running daily settlement job...");
  try{
const today = new Date().toISOString().split("T")[0];
 await sendFinancialReport({ 
  fromDate: today, 
  toDate: today, 
  toEmail: ["kashok2643@gmail.com","shaikno150@gmail.com","saipranav9912345@gmail.com"]
});
    console.log("Collection report mail sent successfully");
  }catch(e){
    console.log("err at send excel of financila",e)
  }

};
const firebaseSettlementJob = async () => {
  console.log("Starting firebase cleanup job...");

  try {
    const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
    const cutoff = Date.now() - THIRTY_DAYS_MS;

    const snapshot = await fire_db
      .ref("notifications")
      .orderByChild("createdAt")
      .endAt(cutoff)
      .once("value");

    if (!snapshot.exists()) {
      console.log("No old notifications found");
      return;
    }

    const updates = {};
    snapshot.forEach((child) => {
      updates[child.key] = null; // delete
    });

    await fire_db.ref("notifications").update(updates);

    console.log("Old notifications deleted successfully");
  } catch (e) {
    console.log("Error while deleting old notifications:", e);
  }
};
module.exports = { dailySettlementJob,firebaseSettlementJob };
