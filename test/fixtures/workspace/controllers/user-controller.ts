export async function getUser(req, res) {
  const userRecord = await users.findById(req.params.id);
  if (!userRecord) return rs;
  return res.status(200).json(userRecord);
}

export async function removeUser(req, res) {
  const userRecord = await users.findById(req.params.id);
  if (!userRecord) return rss;
  return res.sendStatus(204);
}
