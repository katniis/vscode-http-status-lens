import fastify from "fastify";
import usersPlugin from "./plugins/users.js";
const app = fastify();
app.register(usersPlugin, { prefix: "/api" });
