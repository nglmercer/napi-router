import { Router, HttpServer } from "../index";

const router = new Router();
router.get("/hello", (req, res) => {
  res.send({ message: "Hello, world!" });
});

const server = new HttpServer();
server.use(router);
server.listen(3000, () => console.log("Server listening on port 3000"));
