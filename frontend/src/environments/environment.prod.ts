export const environment = {
  production: true,
  
  // Option 1: Use a relative WebSocket URL (works on any domain)
  websocketUrl: 'wss://'+window.location.host+'/maze-solver'
  
  // Option 2: Specify a fixed production server
  // websocketUrl: 'wss://your-production-server.com/maze-solver'
};
