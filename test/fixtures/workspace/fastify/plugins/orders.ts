export default async function ordersPlugin(server: any) {
  server.route({ method: ["GET", "POST"], url: "/", handler: async (request: any, reply: any) => {
    reply.statusCode = 201;
    return reply.send({ ok: true });
  } });
}
