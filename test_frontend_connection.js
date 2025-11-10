#!/usr/bin/env node

const WebSocket = require('ws');

console.log('🧪 Testing frontend-backend connection...');

// Test Backend #1 (maze solving)
const testMazeSolver = () => {
  return new Promise((resolve) => {
    console.log('📡 Connecting to Backend #1 (maze solver) at ws://localhost:8000/api/maze-solver');

    const ws = new WebSocket('ws://localhost:8000/api/maze-solver');

    ws.on('open', () => {
      console.log('✅ Connected to maze solver backend');

      // Send a test request
      const testRequest = {
        session_id: 'frontend-test-' + Date.now(),
        canvas_width: 800,
        canvas_height: 600,
        device_fingerprint: 'frontend_test_client',
        user_agent: 'Node.js Frontend Test',
        accept_language: 'en-US'
      };

      console.log('📤 Sending test request:', JSON.stringify(testRequest, null, 2));
      ws.send(JSON.stringify(testRequest));
    });

    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        console.log('📥 Received from backend:', message);

        if (message.type === 'processing_started') {
          console.log('✅ Backend acknowledged request');
          ws.close();
          resolve(true);
        }
      } catch (e) {
        console.error('❌ Failed to parse message:', e);
        ws.close();
        resolve(false);
      }
    });

    ws.on('error', (error) => {
      console.error('❌ WebSocket error:', error);
      resolve(false);
    });

    ws.on('close', () => {
      console.log('🔌 WebSocket connection closed');
    });

    // Timeout after 5 seconds
    setTimeout(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
        console.log('⏰ Test timed out');
        resolve(false);
      }
    }, 5000);
  });
};

// Test HTTP health endpoint
const testHealthEndpoint = () => {
  return new Promise((resolve) => {
    const http = require('http');

    console.log('🏥 Testing health endpoint at http://localhost:8000/health');

    const req = http.get('http://localhost:8000/health', (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const health = JSON.parse(data);
          console.log('✅ Health endpoint response:', health);
          resolve(true);
        } catch (e) {
          console.error('❌ Failed to parse health response:', e);
          resolve(false);
        }
      });
    });

    req.on('error', (error) => {
      console.error('❌ HTTP error:', error);
      resolve(false);
    });

    req.setTimeout(3000, () => {
      console.log('⏰ Health check timed out');
      resolve(false);
    });
  });
};

// Run tests
const runTests = async () => {
  console.log('🔍 Starting connectivity tests...\n');

  const healthTest = await testHealthEndpoint();
  console.log('');

  const wsTest = await testMazeSolver();
  console.log('');

  console.log('📊 Test Results:');
  console.log(`   Health Endpoint: ${healthTest ? '✅ PASS' : '❌ FAIL'}`);
  console.log(`   WebSocket:       ${wsTest ? '✅ PASS' : '❌ FAIL'}`);
  console.log('');

  if (healthTest && wsTest) {
    console.log('🎉 All tests passed! Backend is ready for frontend connection.');
    console.log('🌐 You can now open https://localhost:4200 to test the full application.');
  } else {
    console.log('⚠️  Some tests failed. Check backend status.');
  }
};

runTests().catch(console.error);