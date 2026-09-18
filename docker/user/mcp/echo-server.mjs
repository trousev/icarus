// Минимальный MCP-сервер по stdio. Нужен, чтобы проверять мост pi → MCP,
// не завися от внешних сервисов и ключей.
import readline from 'node:readline';

const tools = [
  {
    name: 'ping',
    description: 'Проверка связи: отвечает pong, временем сервера и рабочим каталогом.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }

  if (message.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'icarus-echo', version: '1.0.0' },
      },
    });
    return;
  }

  if (message.method === 'notifications/initialized') return;

  if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools } });
    return;
  }

  if (message.method === 'tools/call') {
    const name = message.params?.name;
    if (name !== 'ping') {
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: { content: [{ type: 'text', text: `неизвестный инструмент: ${name}` }], isError: true },
      });
      return;
    }
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        content: [
          {
            type: 'text',
            text: `pong. Время сервера: ${new Date().toISOString()}. Рабочий каталог: ${process.cwd()}`,
          },
        ],
      },
    });
    return;
  }

  if (message.id !== undefined) {
    send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `метод не поддержан: ${message.method}` } });
  }
});
