    export const environment = {
      production: true,
      websocketUrl: '',  // Not used - Cloud Run backend only supports REST
      visualizeUrl: (sessionId: string) => ``,  // Not used - Cloud Run backend only supports REST
      restUrl: `https://maze-solver-backend-349144859836.us-central1.run.app/api/rest/maze-solver`,

      // GPU Renderer Cloud Run API
      gpuRendererUrl: 'https://gpu-maze-renderer-349144859836.us-central1.run.app',

      preferWebsocket: false,  // Cloud Run backend only supports REST API
      useGpuRenderer: true  // Use GPU renderer in production
    };