const listener = { addListener() {}, removeListener() {} };

globalThis.chrome = {
  runtime: { id: 'test-extension', onInstalled: listener, onMessage: listener },
  contextMenus: { onClicked: listener, removeAll: async () => {}, create() {} },
  downloads: { onChanged: listener, onErased: listener },
  storage: { local: { get: async () => ({}) }, sync: {} },
};
