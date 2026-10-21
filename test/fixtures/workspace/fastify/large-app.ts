import fastify from "fastify";
import largeParentPlugin from "./plugins/large-parent.js";
const app = fastify();
app.register(largeParentPlugin, { prefix: "/v1" });
