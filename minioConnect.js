// const minio=require("minio")
// const minioClient=new minio.Client({
// endPoint:"172.30.120.144",
// port: 9000,
//   useSSL: false,
//   accessKey: "minioadmin",
//   secretKey: "minioadmin123"
// })
// module.exports = minioClient;

const minio = require("minio");

const minioClient = new minio.Client({
  endPoint: "images.car24travels.com", 
  port: 443,                           
  useSSL: true,
  accessKey: "minioadmin",
  secretKey: "minioadmin123"
});
console.log("connected to minio")
module.exports = minioClient; 