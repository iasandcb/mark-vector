import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocumentFollower } from './document-sync.mjs';

class Socket {
  static instances = [];
  constructor(url) { this.url = url; this.readyState = 1; Socket.instances.push(this); }
  close() { this.onclose?.(); }
  send() {}
  receive(message) { this.onmessage?.({data: JSON.stringify(message)}); }
}
const ref = {projectId:'한글 p', sessionId:'folder', filename:'a.md'};

test('uses authenticated document endpoint and ignores stale document events', () => {
  const updates = [];
  const follower = createDocumentFollower({onUpdate: (ref, value) => updates.push([ref, value]),
    WebSocketClass: Socket, location: {protocol:'https:', host:'example.test'}});
  follower.follow(ref);
  const old = Socket.instances.at(-1);
  assert.equal(old.url, 'wss://example.test/ws/documents/%ED%95%9C%EA%B8%80%20p/folder/a.md');
  old.receive({type:'ready', content:'가', version:'1'});
  assert.equal(updates.length, 1);
  follower.follow({...ref, filename:'b.md'});
  old.receive({type:'update', content:'stale', version:'2'});
  const current = Socket.instances.at(-1);
  current.receive({type:'update', content:'각', version:'3'});
  assert.equal(updates.length, 2);
  assert.equal(updates[1][0].filename, 'b.md');
  follower.close();
});

test('reconnects and resubscribes, and stops on close', async () => {
  const follower = createDocumentFollower({onUpdate() {}, WebSocketClass: Socket,
    location:{protocol:'http:', host:'localhost'}, retryMs:1});
  follower.follow(ref);
  const first = Socket.instances.at(-1);
  first.close();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.notEqual(Socket.instances.at(-1), first);
  follower.close();
});
