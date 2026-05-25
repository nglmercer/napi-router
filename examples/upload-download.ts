import { serve } from "../adapter/serve.js";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const UPLOAD_DIR = "./uploads";

// Ensure upload directory exists
await mkdir(UPLOAD_DIR, { recursive: true });

const server = await serve({
  port: 9876,
  hostname: "0.0.0.0",

  async fetch(req) {
    const url = new URL(req.url);
    const method = req.method;

    // === WEB UI ===
    if (url.pathname === "/" && method === "GET") {
      return new Response(
        `<!DOCTYPE html>
<html>
<head>
  <title>File Upload Example</title>
</head>
<body>
  <h1>File Upload</h1>

  <h2>Upload a file (multipart/form-data)</h2>
  <form action="/upload" method="POST" enctype="multipart/form-data">
    <input type="file" name="file" required />
    <button type="submit">Upload</button>
  </form>

  <h2>Upload plain text to disk</h2>
  <form action="/upload-text" method="POST">
    <label>Filename: <input type="text" name="filename" placeholder="example.txt" required /></label>
    <br /><br />
    <label>Content:<br />
      <textarea name="content" rows="6" cols="40" placeholder="Write something..."></textarea>
    </label>
    <br /><br />
    <button type="submit">Save to disk</button>
  </form>

  <hr />
  <a href="/files">List uploaded files</a>
</body>
</html>`,
        { headers: { "content-type": "text/html" } },
      );
    }

    // === FILE UPLOAD (multipart — writes to disk) ===
    if (url.pathname === "/upload" && method === "POST") {
      const contentType = req.headers.get("content-type") ?? "";
      const contentLength = Number(req.headers.get("content-length"));

      if (contentType.includes("multipart/form-data")) {
        const formData = await req.formData();
        const file = formData.get("file") as File;

        if (!file) {
          return new Response(
            `<!DOCTYPE html><html><body>
            <p>Error: no file uploaded.</p>
            <a href="/">Back</a>
            </body></html>`,
            { status: 400, headers: { "content-type": "text/html" } },
          );
        }

        const buffer = await file.arrayBuffer();
        const savePath = join(UPLOAD_DIR, file.name);
        await writeFile(savePath, Buffer.from(buffer));

        return new Response(
          `<!DOCTYPE html><html><body>
          <h2>Upload successful</h2>
          <ul>
            <li>Name: ${file.name}</li>
            <li>Size: ${file.size} bytes</li>
            <li>Type: ${file.type}</li>
            <li>Saved to: ${savePath}</li>
          </ul>
          <a href="/">Back</a>
          </body></html>`,
          { headers: { "content-type": "text/html" } },
        );
      }

      // Raw binary upload — writes to disk as upload_<timestamp>.bin
      if (contentType === "application/octet-stream") {
        const buffer = await req.arrayBuffer();
        const savePath = join(UPLOAD_DIR, `upload_${Date.now()}.bin`);
        await writeFile(savePath, Buffer.from(buffer));

        return new Response(
          JSON.stringify({
            success: true,
            fileSize: buffer.byteLength,
            savedTo: savePath,
            contentLength,
          }),
          { headers: { "content-type": "application/json" } },
        );
      }

      // Raw text body
      const body = await req.text();
      const savePath = join(UPLOAD_DIR, `upload_${Date.now()}.txt`);
      await writeFile(savePath, body, "utf-8");

      return new Response(
        JSON.stringify({
          success: true,
          fileSize: body.length,
          savedTo: savePath,
          contentLength,
        }),
        { headers: { "content-type": "application/json" } },
      );
    }

    // === TEXT FORM UPLOAD (plain HTML form — writes to disk) ===
    if (url.pathname === "/upload-text" && method === "POST") {
      const formData = await req.formData();
      const filename = (formData.get("filename") as string)?.trim();
      const content = (formData.get("content") as string) ?? "";

      if (!filename) {
        return new Response(
          `<!DOCTYPE html><html><body>
          <p>Error: filename is required.</p>
          <a href="/">Back</a>
          </body></html>`,
          { status: 400, headers: { "content-type": "text/html" } },
        );
      }

      // Prevent path traversal
      const safeName = filename.replace(/[/\\..]+/g, "_");
      const savePath = join(UPLOAD_DIR, safeName);
      await writeFile(savePath, content, "utf-8");

      return new Response(
        `<!DOCTYPE html><html><body>
        <h2>File saved</h2>
        <ul>
          <li>Filename: ${safeName}</li>
          <li>Size: ${Buffer.byteLength(content, "utf-8")} bytes</li>
          <li>Saved to: ${savePath}</li>
        </ul>
        <a href="/">Back</a>
        </body></html>`,
        { headers: { "content-type": "text/html" } },
      );
    }

    // === FILE DOWNLOAD ===
    if (url.pathname === "/download") {
      if (url.searchParams.get("type") === "text") {
        return new Response("This is a text file downloaded from napi-router", {
          headers: {
            "content-type": "text/plain",
            "content-disposition": 'attachment; filename="downloaded-text.txt"',
          },
        });
      }

      if (url.searchParams.get("type") === "json") {
        return new Response(
          JSON.stringify({
            message: "This is a JSON file downloaded from napi-router",
            timestamp: Date.now(),
          }),
          {
            headers: {
              "content-type": "application/json",
              "content-disposition":
                'attachment; filename="downloaded-data.json"',
            },
          },
        );
      }

      if (url.searchParams.get("type") === "binary") {
        const data = new Uint8Array(1024 * 1024);
        return new Response(data, {
          headers: {
            "content-type": "application/octet-stream",
            "content-disposition":
              'attachment; filename="downloaded-binary.bin"',
          },
        });
      }

      return new Response(
        `<!DOCTYPE html>
<html>
<head><title>Downloaded File</title></head>
<body>
  <h1>File downloaded successfully!</h1>
  <p>This is a simple HTML file from napi-router.</p>
</body>
</html>`,
        {
          headers: {
            "content-type": "text/html",
            "content-disposition":
              'attachment; filename="downloaded-file.html"',
          },
        },
      );
    }

    // === LIST FILES ===
    if (url.pathname === "/files") {
      return new Response(
        JSON.stringify({
          files: [
            { name: "upload.txt", size: 1024, type: "text/plain" },
            { name: "data.json", size: 2048, type: "application/json" },
            {
              name: "binary.bin",
              size: 1048576,
              type: "application/octet-stream",
            },
            { name: "page.html", size: 512, type: "text/html" },
          ],
          totalFiles: 4,
        }),
        { headers: { "content-type": "application/json" } },
      );
    }

    // === DELETE FILE ===
    if (url.pathname === "/delete" && method === "DELETE") {
      const fileName = url.searchParams.get("filename");
      if (fileName) {
        return new Response(
          JSON.stringify({
            success: true,
            message: `File "${fileName}" deleted successfully`,
          }),
          { headers: { "content-type": "application/json" } },
        );
      }

      return new Response(
        JSON.stringify({
          success: false,
          error: "filename query parameter required",
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }

    // === GET FILE INFO ===
    if (url.pathname === "/info" && method === "GET") {
      const fileName = url.searchParams.get("filename");
      if (fileName) {
        return new Response(
          JSON.stringify({
            success: true,
            file: fileName,
            size: Math.floor(Math.random() * 10000) + 100,
            createdAt: Date.now() - Math.floor(Math.random() * 86400000),
          }),
          { headers: { "content-type": "application/json" } },
        );
      }

      return new Response(
        JSON.stringify({
          success: false,
          error: "filename query parameter required",
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }

    return new Response("Not Found", { status: 404 });
  },
});
console.log(server);
