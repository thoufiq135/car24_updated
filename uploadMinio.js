const minioClient = require("./minioConnect");

const uploadToMinio = async (bucketName, fileName, buffer, mimeType) => {

 
  const exists = await minioClient.bucketExists(bucketName);

  
  if (!exists) {
    await minioClient.makeBucket(bucketName);
  }


  await minioClient.putObject(
    bucketName,
    fileName,
    buffer,
    buffer.length,
    {
      "Content-Type": mimeType
    }
  );

  // return image url
  return `https://car24img.car24travels.com/${bucketName}/${fileName}`;
};

module.exports = uploadToMinio;