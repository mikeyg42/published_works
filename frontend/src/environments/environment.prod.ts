    export const environment = {
      production: true,
      websocketUrl: 'wss://michaelglendinning.com/api/maze-solver',
      visualizeUrl: (sessionId: string) => `https://michaelglendinning.com/api/visualize/${sessionId}`,
      restUrl: `https://michaelglendinning.com/api/rest/maze-solver`,
      preferWebsocket: true,
    };