from channels.generic.websocket import AsyncWebsocketConsumer
import json
class JobStatusConsumer(AsyncWebsocketConsumer):
    async def connect(self):
        self.job_id = self.scope['url_route']['kwargs']['job_id']
        self.group_name = f'job_{self.job_id}'
        await self.channel_layer.group_add(self.group_name, self.channel_name)
        await self.accept()

    async def disconnect(self):
            await self.channel_layer.group_discard(self.group_name, self.channel_name)

    async def job_status_update(self, event):
        await self.send(text_data=json.dumps({
            'status': event['status'],
        }))

class WorkerStatusConsumer(AsyncWebsocketConsumer):
    async def connect(self):
        self.group_name = f'workers'
        await self.channel_layer.group_add(self.group_name, self.channel_name)
        await self.accept()

    async def disconnect(self):
            await self.channel_layer.group_discard(self.group_name, self.channel_name)

    async def worker_status_update(self, event):
        await self.send(text_data=json.dumps({
            'status': event['status'],
        }))