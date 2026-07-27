import fs from "fs";

const { NODE_ENV } = process.env;
let credentials = {};

try {
  if (NODE_ENV === "customdev") {
    const key = fs.readFileSync(
      "/etc/apache2/ssl/onlinetestingserver.key",
      "utf8",
    );
    const cert = fs.readFileSync(
      "/etc/apache2/ssl/onlinetestingserver.crt",
      "utf8",
    );
    const ca = fs.readFileSync("/etc/apache2/ssl/onlinetestingserver.ca");
    credentials = { key, cert, ca };
  }
} catch (error) {
  console.log("Error reading SSL files: ", error);
}

export default credentials;
