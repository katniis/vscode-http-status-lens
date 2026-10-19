export const getMyStatuses = async (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Unauthorized" });
  return res.status(200).json({});
};

export default function (req, res) {
  return res.sendStatus(404);
}
