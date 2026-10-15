import LumenSession from "../lumen/LumenSession.js";
const C = window.Cesium;
C.Ion.defaultAccessToken = "";
const widget = new C.CesiumWidget("view", {
  baseLayer: false,
  terrainProvider: new C.EllipsoidTerrainProvider(),
  shadows: true,
});
widget.scene.globe.enableLighting = true;
widget.scene.highDynamicRange = true;
widget.scene.shadowMap.size = 2048;
widget.scene.postProcessStages.exposure = 1;
const session = new LumenSession({
  Cesium: C,
  scene: widget.scene,
  profile: "baseline",
});
window.embedded = { session, widget };
const status = document.getElementById("status");
session
  .load(new URL("../fixtures/local-pilot/dataset.json", import.meta.url))
  .then(({ anchor }) => {
    const frame = C.Transforms.eastNorthUpToFixedFrame(
      C.Cartesian3.fromDegrees(
        anchor.longitude,
        anchor.latitude,
        anchor.height,
      ),
    );
    widget.scene.camera.lookAtTransform(frame, new C.Cartesian3(35, -43, 30));
    widget.scene.camera.lookAtTransform(C.Matrix4.IDENTITY);
    status.textContent =
      "数据集与 GI 已就绪；显示可见性由 session.waitForVisible() 独立检查。";
  })
  .catch((e) => {
    status.textContent = String(e);
  });
document.getElementById("dispose").onclick = () => {
  session.dispose();
  status.textContent = "Session 已销毁；Scene 由宿主继续拥有。";
};
window.addEventListener(
  "pagehide",
  () => {
    session.dispose();
    widget.destroy();
  },
  { once: true },
);
