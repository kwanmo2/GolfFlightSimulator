import "./style.css";
import { GolfFlightApp } from "./app";

const canvas = document.querySelector<HTMLCanvasElement>("#renderCanvas");
const uiRoot = document.querySelector<HTMLElement>("#ui-root");

if (!canvas || !uiRoot) {
  throw new Error("App mount points were not found.");
}

new GolfFlightApp(canvas, uiRoot);
