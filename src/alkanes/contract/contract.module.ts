import { Module } from '@nestjs/common';

import { ContractController } from './contract.controller.js';
import { ContractService } from './contract.service.js';

@Module({
  controllers: [ContractController],
  providers: [ContractService],
})
export class ContractModule { }
