import ordersPlugin from "./orders.js";
export default async function usersPlugin(server: any) {
  server.get("/users", async (request: any, reply: any) => {
    const user = await users.findById(request.params.id);
    if (!user) return reply.code(404).send({ error: "Not Found" });
    return reply.send(user);
  });
  server.register(ordersPlugin, { prefix: "/orders" });
}
