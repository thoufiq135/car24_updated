const {pool,redis}=require("./connectdb")
async function rateLimiter(req,res,next) {
    const key=`rate:${req.ip}`
            const request=await redis.get(key)
            console.log("requests=",request)
            if (request && request >= 50) {
        return res.status(429).json({
          message: "Too many requests. Try again later."
        });
      }
    const newRequests = await redis.incr(key)
    
        if (newRequests === 1) {
            await redis.expire(key,60)
        }
    next()
}
module.exports=rateLimiter;