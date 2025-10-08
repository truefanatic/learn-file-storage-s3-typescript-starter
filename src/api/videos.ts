import { getBearerToken, validateJWT } from "../auth";
import { respondWithJSON } from "./json";
import { getVideo, updateVideo } from "../db/videos";
import type { ApiConfig } from "../config";
import { S3Client, type BunRequest } from "bun";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";
import path from "node:path";
import { randomBytes } from "node:crypto";

export async function handlerUploadVideo(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  const formData = await req.formData();
  const file = formData.get("video");
  if (file instanceof File) {
    const MAX_UPLOAD_SIZE = 1 * 1024 * 1024 * 1024;
    if (file.size > MAX_UPLOAD_SIZE) {
      throw new BadRequestError(
        "Video file exceeds the maximum allowed size of 1GB"
      );
    }
  } else {
    throw new BadRequestError("Video file missing");
  }

  const mediaType = file.type;

  if (mediaType !== "video/mp4") {
    throw new BadRequestError("Video should be video/mp4");
  }

  const data = await file.arrayBuffer();
  if (!data) {
    throw new Error("Error reading file data");
  }

  const video = getVideo(cfg.db, videoId);
  if (!video) {
    throw new NotFoundError("Couldn't find video");
  }
  if (video.userID != userID) {
    throw new UserForbiddenError("Not authorized to update this video");
  }

  const ext = mediaType.split("/")[1];
  const fileName = randomBytes(32).toString("base64url");
  const key = `${fileName}.${ext}`;
  const filePath = path.join(cfg.assetsRoot, key);
  await Bun.write(filePath, data, { createPath: true });

  const aspectRatio = await getVideoAspectRatio(filePath);
  const s3FilePath = path.join(cfg.assetsRoot, aspectRatio, "/", key);
  const processedFilePath = await processVideoForFastStart(filePath);
  const tmpFile = Bun.file(processedFilePath);
  await cfg.s3Client.write(s3FilePath, tmpFile);

  video.videoURL = `https://${cfg.s3Bucket}.s3.${cfg.s3Region}.amazonaws.com/${s3FilePath}`;

  updateVideo(cfg.db, video);

  await tmpFile.delete();
  return respondWithJSON(200, video);
}


export async function getVideoAspectRatio(filePath: string) {
  const process = Bun.spawn([
    "ffprobe",
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height",
    "-of",
    "json",
    filePath,
  ]);

  const stdout = await new Response(process.stdout).text();
  const stderr = await new Response(process.stderr).text();

  const exitCode = await process.exited;

  if (exitCode !== 0) {
    throw new Error(`ffprobe failed: ${stderr}`);
  }

  const json = JSON.parse(stdout.toString());
  const stream = json.streams?.[0];
  if (!stream?.width || !stream?.height) {
    throw new Error("Could not read video dimensions");
  }

  const { width, height } = stream;

  if (Math.floor(width / height) === Math.floor(16 / 9)) {
    return "landscape";
  } else if (Math.floor(width / height) === Math.floor(9 / 16)) {
    return "portrait";
  } else {
    return "other";
  }
}


export async function processVideoForFastStart(filePath: string) {
  const newFilePath = filePath.concat(".processed");
  console.log(newFilePath);
  const process = Bun.spawn([
    "ffmpeg", 
    "-i", filePath,
    "-movflags", "faststart",
    "-map_metadata", "0",
    "-codec", "copy",
    "-f", "mp4", newFilePath,
  ]);
  
  const exitCode = await process.exited;

  if (exitCode !== 0) {
    throw new Error(`ffprobe failed`);
  }
  return newFilePath;
}