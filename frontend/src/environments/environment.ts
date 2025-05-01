export const environment = {
  production: false,
  websocketUrl: 'wss://127.0.0.1:8000/api/maze-solver',
  visualizeUrl: (sessionId: string) => `wss://127.0.0.1:8000/api/visualize/${sessionId}`
  //websocketUrl: 'wss://maze-solver-backend-acn3zn6u4a-uc.a.run.app/maze-solver'
};
