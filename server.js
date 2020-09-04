const express = require('express');
const app = express();
const port = process.env.PORT || 3000;
const Browser = require("./src/Browser.js");

app.use(express.json({limit: "100mb"}));

app.post("/screenshot", async (req, res) => {
  let
    image = null,
    error = null;
  
  try {
    image = await Browser.screenshot(req.body);
  } catch (e) {
    error = e.stack || e.toString();
  }

  res.send({data: image, error: error});
});

app.post("/pdf", async (req, res) => {
  let
    pdf = null,
    error = null;
  
  try {
    pdf = await Browser.pdf(req.body);
  } catch (e) {
    error = e.stack || e.toString();
  }

  res.send({data: pdf, error: error});
});

app.listen(port, () => {
  console.log(`Fury Server started at Port ${port}`);
});