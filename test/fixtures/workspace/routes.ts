import express from "express";

const app = express();

app.get("/users/:id", (req, res) => {
  if (!req.params.id) return res.sendStatus(404);
  return res.status(200).json({ id: req.params.id });
});

void rs404;
