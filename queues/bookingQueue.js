const {redis,pool}=require("../connectdb")
const {Queue}=require("bullmq")
const bookingqueue=new Queue("bookingqueue",{ connection:{
    host: "redis",
      port: 6379
}})
module.exports=bookingqueue  