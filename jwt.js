const jwt= require("jsonwebtoken")
require("dotenv").config()
const key=process.env.jwt_key
async function createJwt(payload){
    if(key){
        const token=jwt.sign(payload,key)
      
        return token
    }else{
        console.log("jwt key not found")
        return false
    }

}
async function veriftJWT(token) {
    if(key){
        const payload=jwt.verify(token,key)
        if(!payload){
return false
        }
        return payload
    }    
}
module.exports={createJwt,veriftJWT};
