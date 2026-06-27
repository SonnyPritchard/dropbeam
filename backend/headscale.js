const http = require("http");
const https = require("https");
const { URL } = require("url");

const request = (method, path, body) => {
  const base = process.env.HEADSCALE_URL || "http://localhost:8080";
  const url = new URL(path, base);
  const transport = url.protocol === "https:" ? https : http;

  const options = {
    hostname: url.hostname,
    port: url.port,
    path: url.pathname + url.search,
    method,
    headers: {
      Authorization: `Bearer ${process.env.HEADSCALE_API_KEY}`,
      "Content-Type": "application/json",
    },
  };

  return new Promise((resolve, reject) => {
    const req = transport.request(options, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString();
        try {
          resolve(JSON.parse(raw));
        } catch {
          resolve(raw);
        }
      });
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
};

const createPreAuthKey = async (user) => {
  const expiration = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const data = await request("POST", "/api/v1/preauthkey", {
    user,
    reusable: false,
    ephemeral: false,
    expiration,
  });
  return data.preAuthKey?.key || data.preAuthKey;
};

const listNodes = () => request("GET", "/api/v1/node");

const deleteNode = (id) => request("DELETE", `/api/v1/node/${id}`);

module.exports = { createPreAuthKey, listNodes, deleteNode };
