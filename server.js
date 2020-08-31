const express = require('express');
const app = express();
const port = process.env.port || 3000;
const Browser = require("./src/Browser.js");

app.use(express.json())

app.post("/screenshot", async (req, res) => {
  let
    image = null,
    error = null;
  
  try {
    image = await Browser.screenshot(req.body);
  } catch (e) {
    error = e.stack;
  }

  res.send({image: image, error: error});
});

app.listen(port, () => {
  console.log(`Fury Server started at Port ${port}`);
});