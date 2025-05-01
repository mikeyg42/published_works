export const environment = {
  production: true,
  websocketUrl: 'wss://michaelglendinning.com/api/maze-solver',
  visualizeUrl: (sessionId: string) => `https://michaelglendinning.com/api/visualize/${sessionId}`
};
